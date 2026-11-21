// Seed operation: puts a managed database on a new secondary (or re-seeds an
// existing one) so that log shipping can take over.
//
//   base          take a fresh FULL on the primary, or pick the newest FULL
//                 (+ its newest DIFF) whose log chain to now is complete
//   prepare       check the target; take an existing database offline if the
//                 user confirmed the overwrite; derive MOVE targets from
//                 RESTORE FILELISTONLY and the target's default paths
//   restore_full  RESTORE DATABASE ... WITH NORECOVERY, MOVE ...
//   restore_diff  RESTORE DATABASE ... (differential) WITH NORECOVERY
//   hand_over     verify the copy and mark the secondary as shipping
//
// The seed holds the restore:<target> lock for its whole run, so the restore
// loop for that secondary waits, while backups on the primary carry on.
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as backups from '../../store/repos/backups.js';
import * as opsRepo from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import * as inspect from '../../sql/inspect.js';
import * as Q from '../../sql/tsql.js';
import * as health from '../health.js';
import { query, T, sqlErrorText } from '../../sql/pool.js';
import { startBackup, recordBackupFile, ensureDir, uniqueRelPath } from '../backup.js';
import { createOperation, runOperation } from '../operations.js';
import { tryAcquire, holders, BusyError } from '../locks.js';
import * as forks from '../../store/repos/forks.js';
import { newestBaseOnLineage, chainGap } from '../chain.js';
import { restoreFile, fileOnDisk } from '../restore.js';
import { buildMoves, undoFilePath } from '../restore-plan.js';
import { checkLive, nudge } from '../restore-loop.js';
import { restoreCompatibility } from '../../sqlversion.js';
import { translatePath, backupRelDir } from '../../paths.js';
import { pathOpts } from '../context.js';
import { publish } from '../../bus.js';
import { nowIso } from '../../store/db.js';

export const SOURCES = ['new_full', 'latest'];
export const RESTORE_MODES = ['norecovery', 'standby'];
const WAIT_FOR_BACKUP_MS = 30 * 60_000;

function fail(status, message, details) {
    return Object.assign(new Error(message), { status, expose: true, details });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything the UI needs to offer a seed of `databaseId` onto a server, and
 * the checks the seed itself relies on. Throws (with an HTTP status) when
 * the seed is impossible.
 */
export async function seedPreflight(databaseId, targetServerId, { reseed = false } = {}) {
    const db = databases.get(databaseId);
    if (!db || db.status !== 'managed') throw fail(404, 'Database is not managed');
    const primary = databases.primaryOf(db.id);
    if (!primary) throw fail(409, `${db.name} has no primary`);
    const target = serversRepo.get(targetServerId);
    if (!target) throw fail(404, 'Server not found');
    if (target.id === primary.server_id) throw fail(409, `${target.name} is the primary of ${db.name}`);
    if (!target.enabled) throw fail(409, `Server ${target.name} is disabled`);
    const existing = databases.replica(db.id, target.id);
    if (existing?.role === 'diverged' && !reseed) {
        throw fail(409, `${target.name} holds an old, out-of-sync copy of ${db.name}. Use Reinitialize on it instead, which can keep a safety backup of that copy first.`);
    }
    if (reseed && !existing) throw fail(409, `${target.name} has no copy of ${db.name} yet; use Add secondary instead`);
    const primaryServer = serversRepo.get(primary.server_id);
    const ph = health.getHealth(primaryServer.id);
    const th = health.getHealth(target.id);
    if (!ph?.ok) throw fail(503, `Primary ${primaryServer.name} is unreachable`);
    if (!th?.ok) throw fail(503, `Server ${target.name} is unreachable`);

    let live;
    try {
        live = await inspect.dbRestoreState(target.id, db.name);
    } catch (err) {
        throw fail(503, `Cannot inspect ${target.name}: ${sqlErrorText(err)}`);
    }
    let standbyPath = null;
    try {
        standbyPath = undoFilePath(target, db.name);
    } catch {
        /* reported through standbyPath: null */
    }
    return {
        db,
        primaryServer,
        target,
        replica: existing || null,
        compat: restoreCompatibility(ph.info?.majorVersion, th.info?.majorVersion),
        existsOnTarget: live ? { state: live.state, standby: live.standby, sameDatabase: !!db.family_guid && live.familyGuid === db.family_guid } : null,
        standbyPath,
        dataPath: target.default_data_path,
        logPath: target.default_log_path,
    };
}

/**
 * Validates and starts a seed. Resolves once the operation exists; `done`
 * settles when it has finished.
 */
export async function startSeed(
    databaseId,
    { serverId, source = 'new_full', restoreMode = 'norecovery', overwrite = false, confirm = null, reseed = false, safetyBackup = false },
) {
    if (!SOURCES.includes(source)) throw fail(400, `source must be one of ${SOURCES.join(', ')}`);
    if (!RESTORE_MODES.includes(restoreMode)) throw fail(400, `restore_mode must be one of ${RESTORE_MODES.join(', ')}`);
    const pf = await seedPreflight(databaseId, serverId, { reseed });
    const { db, target } = pf;
    if (reseed) {
        // A reseed always replaces whatever is on the target; the typed name is the confirmation.
        if (confirm !== db.name) throw fail(400, `Type ${db.name} to confirm that the copy on ${target.name} will be replaced`);
        overwrite = true;
    }
    if (!pf.compat.ok) throw fail(409, pf.compat.reason);
    if (restoreMode === 'standby') {
        if (!pf.compat.standby) throw fail(409, `A read-only copy (STANDBY) needs the same SQL Server version on both servers. ${pf.compat.reason}`);
        if (!pf.standbyPath) throw fail(409, `A read-only copy needs a folder for its undo file on ${target.name}: set "Folder for undo files of read-only copies" on the server`);
    }
    if (pf.existsOnTarget) {
        if (!overwrite) {
            throw fail(409, `${db.name} already exists on ${target.name}. Tick "Overwrite the existing database" and type the database name to replace it.`, {
                code: 'exists',
            });
        }
        if (confirm !== db.name) throw fail(400, `Type ${db.name} to confirm that the copy on ${target.name} will be overwritten`);
    }

    const release = tryAcquire(db.id, `restore:${target.id}`);
    if (!release) throw new BusyError(db.id, `seed on ${target.name}`, holders(db.id));
    try {
        const params = {
            targetServerId: target.id,
            source,
            restoreMode,
            overwrite: !!pf.existsOnTarget,
            reseed: !!reseed,
            safetyBackup: !!(reseed && safetyBackup),
            previousRole: pf.replica?.role ?? null,
        };
        databases.addSecondary({ databaseId: db.id, serverId: target.id, restoreMode });
        const stepDefs = seedSteps({ db, target, params });
        const operation = createOperation({ type: reseed ? 'reseed' : 'seed', databaseId: db.id, serverId: target.id, params, stepDefs });
        events.add(
            reseed ? 'warn' : 'info',
            'seed',
            `${reseed ? 'Reseeding' : 'Seeding'} ${db.name} on ${target.name} from ${source === 'new_full' ? 'a fresh FULL backup' : 'the latest FULL (+ DIFF)'}${params.overwrite ? ', replacing the existing copy' : ''}${params.safetyBackup ? ' after a safety backup of it' : ''}`,
            { databaseId: db.id, serverId: target.id, operationId: operation.id },
        );
        publish('replica.changed', { databaseId: db.id, serverId: target.id });
        return { operation, done: execute(operation.id, stepDefs, release, db, target) };
    } catch (err) {
        release();
        throw err;
    }
}

/** Re-runs a failed or interrupted seed from its first unfinished step. */
export async function resumeSeed(op) {
    const db = databases.get(op.database_id);
    const target = serversRepo.get(op.params.targetServerId);
    if (!db || db.status !== 'managed' || !target) throw fail(409, 'The database or the target server no longer exists');
    const rep = databases.replica(db.id, target.id);
    if (!rep || rep.role !== 'secondary' || rep.chain_state !== 'seeding') {
        throw fail(409, `${target.name} is no longer being set up as a secondary of ${db.name}; use Add secondary again instead`);
    }
    const release = tryAcquire(db.id, `restore:${target.id}`);
    if (!release) throw new BusyError(db.id, `seed on ${target.name}`, holders(db.id));
    databases.updateReplica(db.id, target.id, { chain_reason: null });
    events.add('info', 'seed', `Resuming adding ${target.name} as a secondary of ${db.name} (operation #${op.id})`, { databaseId: db.id, serverId: target.id, operationId: op.id });
    const stepDefs = seedSteps({ db, target, params: op.params });
    return { operation: op, done: execute(op.id, stepDefs, release, db, target) };
}

function execute(opId, stepDefs, release, db, target) {
    let ok = false;
    return runOperation(opId, stepDefs)
        .then((op) => {
            ok = op.status === 'succeeded';
            if (ok) {
                events.add('info', 'seed', `${target.name} now has a full copy of ${db.name}; from here on it receives the log backups`, { databaseId: db.id, serverId: target.id, operationId: op.id });
            } else {
                databases.updateReplica(db.id, target.id, { chain_reason: `Seed operation #${op.id} ${op.status}: ${op.error}` });
            }
            publish('replica.changed', { databaseId: db.id, serverId: target.id });
            return op;
        })
        .finally(() => {
            release();
            if (ok) nudge(db.id, target.id, { force: true });
        });
}

/** Step definitions; rebuilt from the persisted params when resuming. */
export function seedSteps({ db, target, params }) {
    const fileOf = (id) => {
        const f = id ? backups.get(id) : null;
        if (id && !f) throw new Error(`Backup file #${id} is no longer in the catalog`);
        return f;
    };
    const liveState = () => inspect.dbRestoreState(target.id, db.name);

    const steps = [
        {
            name: 'base',
            label: params.source === 'new_full' ? 'Take a FULL backup on the primary' : 'Use the newest FULL (and DIFF) backup',
            check: (ctx) => {
                if (ctx.state.fullFileId) return `Using FULL #${ctx.state.fullFileId}${ctx.state.diffFileId ? ` and DIFF #${ctx.state.diffFileId}` : ''}`;
                // Crash while the child backup ran: reuse it if it completed (startup reconcile settles it).
                const child = ctx.state.backupOpId ? opsRepo.get(ctx.state.backupOpId) : null;
                if (child?.status === 'succeeded' && child.ctx.fileId) {
                    ctx.save({ fullFileId: child.ctx.fileId, diffFileId: null });
                    return `Using FULL #${child.ctx.fileId} from backup operation #${child.id}`;
                }
                return false;
            },
            run: (ctx) => (params.source === 'new_full' ? takeFull(ctx, db) : pickLatest(ctx, db)),
        },
        {
            name: 'prepare',
            label: `Prepare ${target.name}`,
            run: async (ctx) => {
                const full = fileOf(ctx.state.fullFileId);
                if (!fileOnDisk(full)) throw new Error(`Backup file ${full.rel_path} is missing from the backup volume`);
                const live = await liveState();
                let note = '';
                if (live) {
                    if (!params.overwrite) {
                        throw new Error(`Database ${db.name} now exists on ${target.name} (${live.state}); it did not when this started. Use Add secondary again and confirm the overwrite.`);
                    }
                    if (live.state === 'ONLINE') {
                        await query(target.id, Q.SET_OFFLINE, { db: T.sysname(db.name) }, { timeoutMs: 120_000 });
                        note = `Took the existing ${db.name} on ${target.name} offline. `;
                    }
                }
                const t = serversRepo.get(target.id); // fresh default paths from the latest health check
                const list = await inspect.fileList(target.id, translatePath(full.rel_path, t, pathOpts('rel', 'sql')));
                const moves = buildMoves(list, { defaultDataPath: t.default_data_path, defaultLogPath: t.default_log_path, dbName: db.name });
                ctx.save({ moves, replace: !!live });
                return `${note}${moves.map((m) => `${m.from} → ${m.to}`).join('; ')}`;
            },
        },
        {
            name: 'restore_full',
            label: `Restore the FULL on ${target.name}`,
            check: async (ctx) => {
                const full = fileOf(ctx.state.fullFileId);
                const live = await liveState();
                if (live?.restoring && live.lastRestoreUuid === full.backup_set_uuid) return `Already restored on ${target.name}`;
                return false;
            },
            run: async (ctx) => {
                const full = fileOf(ctx.state.fullFileId);
                if (!fileOnDisk(full)) throw new Error(`Backup file ${full.rel_path} is missing from the backup volume`);
                await restoreFile({
                    db,
                    server: target,
                    file: full,
                    operationId: ctx.op.id,
                    moves: ctx.state.moves,
                    replace: !!ctx.state.replace,
                    onInfo: (m) => ctx.progress(m),
                });
                return recordPosition(db, target, full);
            },
        },
        {
            name: 'restore_diff',
            label: `Restore the DIFF on ${target.name}`,
            check: async (ctx) => {
                if (!ctx.state.diffFileId) return 'No DIFF to restore';
                const diff = fileOf(ctx.state.diffFileId);
                const live = await liveState();
                if (live?.restoring && live.lastRestoreUuid === diff.backup_set_uuid) return `Already restored on ${target.name}`;
                return false;
            },
            run: async (ctx) => {
                const diff = fileOf(ctx.state.diffFileId);
                if (!fileOnDisk(diff)) throw new Error(`Backup file ${diff.rel_path} is missing from the backup volume`);
                await restoreFile({ db, server: target, file: diff, operationId: ctx.op.id, onInfo: (m) => ctx.progress(m) });
                return recordPosition(db, target, diff);
            },
        },
        {
            name: 'hand_over',
            label: 'Start receiving log backups',
            check: () => (databases.replica(db.id, target.id)?.chain_state === 'ok' ? 'Already shipping' : false),
            run: async () => {
                const rep = databases.replica(db.id, target.id);
                if (!rep || rep.role !== 'secondary') throw new Error(`${target.name} is no longer a secondary of ${db.name}`);
                const live = await liveState();
                const problem = checkLive(db, target, live);
                if (problem) throw new Error(problem.reseed || problem.retry);
                databases.updateReplica(db.id, target.id, {
                    chain_state: 'ok',
                    chain_reason: null,
                    position_lsn: live.position,
                    position_fork_guid: live.forkGuid,
                });
                return `${target.name} is ready; Mostly On restores the log backups there from now on`;
            },
        },
    ];
    return params.reseed ? [safetyBackupStep({ db, target, params }), ...steps] : steps;
}

/**
 * Reseed of a diverged copy (D9): a COPY_ONLY backup of it goes to
 * <root>/<db>/DIVERGED/ before it is replaced. Retention never deletes these
 * files and the chain logic ignores them; they may hold the only copy of
 * transactions that never reached the new primary.
 */
function safetyBackupStep({ db, target, params }) {
    const sqlPathOf = (relPath) => translatePath(relPath, target, pathOpts('rel', 'sql'));
    return {
        name: 'safety_backup',
        label: `Safety backup of the current copy on ${target.name}`,
        guidance: 'Nothing has been replaced yet. Resume to try again, or start Reinitialize again without the safety backup.',
        check: async (ctx) => {
            if (!params.safetyBackup) return 'Not requested';
            if (ctx.state.safetyFileId) return `Safety backup #${ctx.state.safetyFileId} already taken`;
            if (!ctx.state.safetyRelPath) return false;
            const bs = await inspect.backupsetByPath(target.id, db.name, sqlPathOf(ctx.state.safetyRelPath));
            if (!bs) return false;
            const file = backups.byRelPath(ctx.state.safetyRelPath) || recordBackupFile({ db, server: target, bs, relPath: ctx.state.safetyRelPath, operationId: ctx.op.id, type: 'DIVERGED' });
            ctx.save({ safetyFileId: file.id });
            return `The safety backup was taken before the interruption; recorded as #${file.id}`;
        },
        run: async (ctx) => {
            const live = await inspect.dbRestoreState(target.id, db.name);
            if (!live) return `Nothing to back up: ${db.name} does not exist on ${target.name}`;
            if (live.restoring) {
                return `Skipped: the copy on ${target.name} was still receiving logs, so it cannot be backed up, and it holds nothing the primary does not have.`;
            }
            let note = '';
            if (live.state === 'OFFLINE') {
                await query(target.id, Q.SET_ONLINE_RESTRICTED, { db: T.sysname(db.name) }, { timeoutMs: 300_000 });
                note = ' (brought ONLINE in RESTRICTED_USER mode for the backup)';
            } else if (live.state !== 'ONLINE') {
                return `Skipped: ${db.name} is ${live.state} on ${target.name} and cannot be backed up`;
            }
            ensureDir(target, backupRelDir(db.name, 'DIVERGED'));
            const relPath = uniqueRelPath(db, 'DIVERGED', target);
            ctx.save({ safetyRelPath: relPath });
            const p = {
                db: T.sysname(db.name),
                path: T.nvarchar(sqlPathOf(relPath)),
                name: T.nvarchar('Mostly On diverged copy', 128),
                description: T.nvarchar(`mostly-on op:${ctx.op.id} diverged`, 255),
            };
            try {
                await query(target.id, Q.safetyBackup(), p, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) });
            } catch (err) {
                if (!err.number) throw err;
                ctx.progress(`Backup failed (${sqlErrorText(err)}); retrying and skipping damaged pages (CONTINUE_AFTER_ERROR)`);
                await query(target.id, Q.safetyBackup({ continueAfterError: true }), p, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) });
            }
            const bs = await inspect.backupsetByPath(target.id, db.name, sqlPathOf(relPath));
            if (!bs) throw new Error(`SQL Server on ${target.name} has no record of the safety backup to ${relPath}`);
            const file = recordBackupFile({ db, server: target, bs, relPath, operationId: ctx.op.id, type: 'DIVERGED' });
            ctx.save({ safetyFileId: file.id });
            return `#${file.id} ${relPath}${note}`;
        },
    };
}

async function recordPosition(db, target, file) {
    const live = await inspect.dbRestoreState(target.id, db.name);
    databases.updateReplica(db.id, target.id, {
        position_lsn: live?.position ?? null,
        position_fork_guid: live?.forkGuid ?? null,
        last_restored_file_id: file.id,
        last_restored_at: nowIso(),
    });
    publish('replica.changed', { databaseId: db.id, serverId: target.id });
    return `${file.rel_path} restored`;
}

async function takeFull(ctx, db) {
    const deadline = Date.now() + WAIT_FOR_BACKUP_MS;
    for (;;) {
        let started;
        try {
            started = await startBackup(db.id, 'FULL', { trigger: 'seed', parentId: ctx.op.id });
        } catch (err) {
            if (err instanceof BusyError && Date.now() < deadline) {
                ctx.progress('Waiting for a running FULL or DIFF backup to finish');
                await sleep(5000);
                continue;
            }
            throw err;
        }
        ctx.save({ backupOpId: started.operation.id });
        ctx.progress(`FULL backup running (operation #${started.operation.id})`);
        const { operation, file } = await started.done;
        if (operation.status !== 'succeeded' || !file) throw new Error(`The FULL backup (operation #${operation.id}) failed: ${operation.error}`);
        ctx.save({ fullFileId: file.id, diffFileId: null });
        return `FULL #${file.id} ${file.rel_path}`;
    }
}

function pickLatest(ctx, db) {
    const inFamily = (f) => !db.family_guid || !f.family_guid || f.family_guid === db.family_guid;
    // Refresh file_status of the candidate bases first, so a FULL deleted by hand is not picked.
    for (const f of backups.all(db.id)) if (inFamily(f) && (f.type === 'FULL' || f.type === 'DIFF') && f.file_status !== 'deleted') fileOnDisk(f);
    const files = backups.all(db.id).filter(inFamily);
    const lineage = forks.lineage(db.id);
    const base = newestBaseOnLineage(files, lineage);
    if (!base) throw new Error(`There is no FULL backup of ${db.name} on the backup share. Choose "A new FULL backup, taken now" instead.`);
    const gap = chainGap(files, base.position, lineage);
    if (gap) throw new Error(`Some log backups after ${base.diff ? base.diff.rel_path : base.full.rel_path} are missing: ${gap} Choose "A new FULL backup, taken now" instead.`);
    ctx.save({ fullFileId: base.full.id, diffFileId: base.diff?.id ?? null });
    return `FULL #${base.full.id} ${base.full.rel_path}${base.diff ? `, DIFF #${base.diff.id} ${base.diff.rel_path}` : ''}`;
}
