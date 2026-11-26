// Point-in-time restore, in two kinds:
//
// Copy (pitr_copy): restores the database as it was at a moment under a new
// name on any registered server, next to everything else. Nothing that exists
// is touched and the copy is not managed by Mostly-On.
//   validate, fresh_log (only if the moment is newer than the last log
//   backup), plan, prepare (MOVE targets with new file names), restore (FULL,
//   DIFF, logs WITH STOPAT), recover (+ owner)
//
// Rollback (pitr_rollback): puts the managed database itself back to the
// moment, on the primary and on every secondary.
//   lock, validate, tail_log (on the primary, which then stops taking writes;
//   everything after the moment stays in the backups), plan, restore_primary
//   (REPLACE, logs WITH STOPAT), recover, record_fork (the database continues
//   on a new branch of its history, as after a failover), secondaries (each
//   restored to the same moment, so it can follow the new branch; one that
//   cannot is marked for reinitializing), first_log
//
// Restoring a log WITH STOPAT leaves the database inside that log once it
// reaches the moment; until then the whole log is applied and the next one is
// needed (chain.stopReached()). Every server stops at the same LSN, which is
// where the rolled-back primary's history branches off (verified on SQL
// Server 2019 and 2025: the secondaries continue from the new primary's first
// log backup).
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as backups from '../../store/repos/backups.js';
import * as forks from '../../store/repos/forks.js';
import * as events from '../../store/repos/events.js';
import * as opsRepo from '../../store/repos/operations.js';
import * as inspect from '../../sql/inspect.js';
import * as P from '../../sql/privileged.js';
import * as health from '../health.js';
import * as L from '../../lsn.js';
import { withDedicated } from '../../sql/pool.js';
import { createOperation, runOperation } from '../operations.js';
import { BusyError } from '../locks.js';
import { nudgeDatabase } from '../restore-loop.js';
import { startBackup, ensureDir, uniqueRelPath } from '../backup.js';
import { restorableRange, pointInTimePlan, stopReached, stopAtLocal, lineageProblem } from '../chain.js';
import { confirmOnDisk, fileOnDisk, assertSameBackup } from '../restore.js';
import { copyMoves, inPlaceMoves } from '../restore-plan.js';
import { translatePath, backupRelDir, dbFolder } from '../../paths.js';
import { isBackupOnly, dbLabel } from '../backup-rules.js';
import { pathOpts } from '../context.js';
import { publish } from '../../bus.js';
import { nowIso } from '../../store/db.js';
import { fail, errText, sleep, lockHolder, recordFork, ownerNote, firstLogStep, catalogTail, assertStillApplies, LOCK_GUIDANCE } from './shared.js';

export const MODES = ['copy', 'rollback'];
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
const SECOND_MS = 1000;

// --- what can be restored -------------------------------------------------------------

function managedDb(databaseId) {
    const db = databases.get(databaseId);
    if (!db || db.status !== 'managed') throw fail(404, 'Database is not managed');
    if (isBackupOnly(db)) {
        throw fail(409, `Mostly-On only backs up ${dbLabel(db)}; it does not perform managed restores. Backup files live in ${dbFolder(db.name, db.backup_only_server_name)} on the backup share.`);
    }
    const primary = databases.primaryOf(db.id);
    if (!primary) throw fail(409, `${db.name} has no primary`);
    return { db, primary, primaryServer: serversRepo.get(primary.server_id) };
}

/** The database's backups in its current family (msdb keeps history of dropped namesakes). */
function familyFiles(db) {
    return backups.all(db.id).filter((f) => !db.family_guid || !f.family_guid || f.family_guid === db.family_guid);
}

/**
 * The moments `databaseId` can be restored to. `to` is the newest moment the
 * backups hold; while the primary is reachable any later moment up to now
 * works too, because the restore takes a log backup first (`untilNow`).
 */
export function restoreRange(databaseId) {
    const { db, primary, primaryServer } = managedDb(databaseId);
    const r = restorableRange({ files: familyFiles(db), lineage: forks.lineage(db.id) });
    const primaryUp = !!health.getHealth(primary.server_id)?.ok && health.dbState(primary.server_id, db.name)?.state === 'ONLINE';
    return {
        database: db.name,
        primary: { server_id: primaryServer.id, name: primaryServer.name, ok: primaryUp, tz_offset_minutes: health.getHealth(primaryServer.id)?.info?.tzOffsetMinutes ?? null },
        from: r.from,
        to: r.to,
        untilNow: primaryUp && !!r.from,
        now: nowIso(),
        problem: r.problem,
        servers: serversRepo
            .list()
            .filter((s) => s.enabled)
            .map((s) => ({ id: s.id, name: s.name, ok: !!health.getHealth(s.id)?.ok, role: databases.replica(db.id, s.id)?.role ?? null })),
        secondaries: databases
            .replicas(db.id)
            .filter((r2) => r2.role === 'secondary')
            .map((r2) => ({ server_id: r2.server_id, name: r2.server_name, chain_state: r2.chain_state, ok: !!health.getHealth(r2.server_id)?.ok })),
    };
}

/** Checks a moment against the range; returns it as an ISO string. */
function checkMoment(range, at, { mode }) {
    const t = new Date(at).getTime();
    if (!at || !Number.isFinite(t)) throw fail(400, 'Choose the date and time to restore to');
    if (!range.from) throw fail(409, `${range.database} cannot be restored to a point in time: ${range.problem}`);
    if (t < new Date(range.from).getTime()) throw fail(409, `The oldest moment ${range.database} can be restored to is ${range.from} (the oldest usable FULL backup)`);
    const now = Date.now();
    if (t > now) throw fail(409, 'That moment is in the future');
    const end = range.to ? new Date(range.to).getTime() : null;
    if ((end === null || t > end) && !range.untilNow) {
        throw fail(409, `The backups of ${range.database} only reach ${range.to ?? 'the FULL backup'}, and the primary is not reachable to take a new log backup`);
    }
    if (mode === 'rollback' && !range.primary.ok) throw fail(409, `The primary ${range.primary.name} must be online to roll ${range.database} back`);
    return new Date(t).toISOString();
}

// --- restoring one copy to the moment ------------------------------------------------------

/** The plan's files, from the ids saved in the operation. */
function planFiles(ctx) {
    const get = (id) => {
        const f = backups.get(id);
        if (!f) throw new Error(`Backup file #${id} is no longer in the catalog`);
        return f;
    };
    const p = ctx.state.plan;
    return { full: get(p.fullId), diff: p.diffId ? get(p.diffId) : null, logs: p.logIds.map(get) };
}

/** Works out the plan and checks every file is on the share; saves it in the operation. */
async function makePlan(ctx, db, at) {
    for (const f of familyFiles(db)) if (f.file_status !== 'deleted') fileOnDisk(f);
    const plan = pointInTimePlan({ files: familyFiles(db), lineage: forks.lineage(db.id), at });
    if (plan.problem) throw new Error(plan.problem);
    for (const f of [plan.full, plan.diff, ...plan.logs].filter(Boolean)) {
        if (!(await confirmOnDisk(f))) throw new Error(`Backup file ${f.rel_path} is missing from the backup share`);
    }
    const planFileIds = [plan.full.id, plan.diff?.id, ...plan.logs.map((f) => f.id)].filter(Boolean);
    ctx.save({ plan: { fullId: plan.full.id, diffId: plan.diff?.id ?? null, logIds: plan.logs.map((f) => f.id) }, planFileIds });
    const last = plan.logs.at(-1);
    return `FULL ${plan.full.rel_path}${plan.diff ? `, DIFF ${plan.diff.rel_path}` : ''}, then ${plan.logs.length} log backup(s)${last ? ` up to ${last.rel_path}` : ''}`;
}

/** STOPAT in the local time of the server that wrote the log (falls back to the restoring server's). */
function stopAtFor(log, at, restoringServerId) {
    const offset = health.getHealth(log.server_id)?.info?.tzOffsetMinutes ?? health.getHealth(restoringServerId)?.info?.tzOffsetMinutes ?? 0;
    return stopAtLocal(at, offset);
}

/**
 * Restores FULL, DIFF and logs (WITH STOPAT) of the plan as `name` on
 * `server`, leaving it RESTORING at the moment. Resumable: progress is kept
 * in ctx.state.restored[key].
 * Returns { position, reached, logIds } (logIds: the logs actually restored).
 */
async function restoreToMoment(ctx, { key, server, name, files, at, moves, replace = false, mustNotExist = false, logIds = null, priority = false }) {
    const get = () => ctx.state.restored?.[key] ?? {};
    const mark = (patch) => ctx.save({ restored: { ...(ctx.state.restored ?? {}), [key]: { ...get(), ...patch } } });
    const sqlPath = (f) => translatePath(f.rel_path, server, pathOpts('rel', 'sql'));
    const onInfo = (m) => ctx.progress(`${server.name}: ${m}`);
    // A rollback (priority) never waits for a free connection on the server; a copy takes its turn.
    const runOpts = { timeoutMs: 0, onInfo, onWait: (t) => ctx.progress(t), priority };
    const t = new Date(at).getTime();

    if (!get().full) {
        if (!(await confirmOnDisk(files.full))) throw new Error(`Backup file ${files.full.rel_path} is missing from the backup share`);
        ctx.progress(`${server.name}: restoring ${files.full.rel_path}`);
        await assertSameBackup(server, files.full, sqlPath(files.full));
        await P.run(server.id, P.restoreDatabase({ db: name, path: sqlPath(files.full), moves, replace, mustNotExist }), runOpts);
        mark({ full: true });
    }
    if (files.diff && !get().diff) {
        ctx.progress(`${server.name}: restoring ${files.diff.rel_path}`);
        await assertSameBackup(server, files.diff, sqlPath(files.diff));
        await P.run(server.id, P.restoreDatabase({ db: name, path: sqlPath(files.diff) }), runOpts);
        mark({ diff: true });
    }

    const logs = logIds ? files.logs.filter((f) => logIds.includes(f.id)) : files.logs;
    const live = async () => {
        const l = await inspect.dbRestoreState(server.id, name);
        if (!l?.restoring) throw new Error(`${name} on ${server.name} is ${l?.state ?? 'missing'}; Mostly-On expected it to be restoring`);
        return l.position;
    };
    let position = await live();
    for (const log of logs) {
        const state = get();
        const applied = new Set(state.logs ?? []);
        // Interrupted during this RESTORE: it went through if the position moved.
        if (state.attempting === log.id && position !== state.before) {
            applied.add(log.id);
            mark({ logs: [...applied], attempting: null });
        }
        if (applied.has(log.id)) {
            if (stopReached(position, log)) return { position, reached: true, logIds: [...applied] };
            continue;
        }
        if (position && L.lte(log.last_lsn, position)) continue; // the base already holds all of it
        if (!(await confirmOnDisk(log))) throw new Error(`Backup file ${log.rel_path} is missing from the backup share`);
        // Only a log that may hold the moment gets STOPAT: earlier ones are restored whole,
        // so servers in other time zones never stop too early.
        const mayHold = !log.backup_finish || new Date(log.backup_finish).getTime() + SECOND_MS >= t;
        ctx.progress(`${server.name}: restoring ${log.rel_path}${mayHold ? ' up to the moment' : ''}`);
        await assertSameBackup(server, log, sqlPath(log));
        mark({ attempting: log.id, before: position });
        await P.run(server.id, P.restoreLog({ db: name, path: sqlPath(log), stopAt: mayHold ? stopAtFor(log, at, server.id) : null }), runOpts);
        applied.add(log.id);
        mark({ logs: [...applied], attempting: null });
        position = await live();
        if (stopReached(position, log)) return { position, reached: true, logIds: [...applied] };
    }
    return { position, reached: false, logIds: [...(get().logs ?? [])] };
}

// --- copy ------------------------------------------------------------------------------

function copySteps({ db, target, params }) {
    const name = params.newName;
    return [
        {
            name: 'validate',
            label: `Check ${target.name}`,
            guidance: 'Nothing has been restored yet. Fix the problem named in the error and resume, or mark the operation resolved.',
            check: (ctx) => (ctx.state.restored?.copy?.full ? `${name} is already being restored on ${target.name}` : false),
            run: async () => {
                if (!health.getHealth(target.id)?.ok) throw new Error(`${target.name} is unreachable`);
                const live = await inspect.dbRestoreState(target.id, name);
                if (live) throw new Error(`A database named ${name} already exists on ${target.name}; choose another name`);
                return `${target.name} is ready; ${name} does not exist there yet`;
            },
        },
        freshLogStep(db, params.at),
        {
            name: 'plan',
            label: 'Choose the backups to restore',
            guidance: 'Nothing has been restored yet. If a backup file is missing, put it back on the share and resume, or choose a later moment.',
            check: (ctx) => (ctx.state.plan ? 'Already chosen' : false),
            run: (ctx) => makePlan(ctx, db, params.at),
        },
        {
            name: 'prepare',
            label: `Choose file names for ${name} on ${target.name}`,
            check: (ctx) => (ctx.state.moves ? 'Already chosen' : false),
            run: async (ctx) => {
                const { full } = planFiles(ctx);
                const t = serversRepo.get(target.id);
                const list = await inspect.fileList(target.id, translatePath(full.rel_path, t, pathOpts('rel', 'sql')));
                const moves = copyMoves(list, { defaultDataPath: t.default_data_path, defaultLogPath: t.default_log_path, newName: name });
                ctx.save({ moves });
                return moves.map((m) => `${m.from} → ${m.to}`).join('; ');
            },
        },
        {
            name: 'restore',
            label: `Restore ${name} on ${target.name} to the moment`,
            guidance: `${name} on ${target.name} is only partly restored (RESTORING). Fix the cause and resume, or remove it with DROP DATABASE [${name}]; on ${target.name} and mark the operation resolved. ${db.name} itself is not affected.`,
            run: async (ctx) => {
                const r = await restoreToMoment(ctx, { key: 'copy', server: target, name, files: planFiles(ctx), at: params.at, moves: ctx.state.moves, mustNotExist: true });
                ctx.save({ stoppedAt: r.position });
                return `${r.logIds.length} log backup(s) restored; stopped at LSN ${r.position}`;
            },
        },
        {
            name: 'recover',
            label: `Bring ${name} online on ${target.name}`,
            guidance: `${name} on ${target.name} is restored but not online yet. Resume to try again.`,
            check: async () => {
                const live = await inspect.dbRestoreState(target.id, name);
                return live?.state === 'ONLINE' && !live.restoring && !(await inspect.dbBackupState(target.id, name))?.ownedByService ? `${name} is already online` : false;
            },
            run: async (ctx) => {
                const owner = databases.get(db.id);
                const r = await P.run(target.id, P.recover({ db: name, ownerSid: owner?.owner_sid, ownerName: owner?.owner_name }), { timeoutMs: 0, onWait: (t) => ctx.progress(t) });
                const note = ownerNote(db, target, owner, r.recordset[0], { name, category: 'restore', record: false, whose: `the owner of ${db.name}` });
                return `${name} is online on ${target.name}; ${note}`;
            },
        },
    ];
}

/**
 * msdb keeps backup times in whole seconds: a log backup that starts in the
 * same second as the moment cannot be shown to hold it. Before taking the log
 * backup that must reach the moment, wait until the moment is safely past.
 */
async function waitPastMoment(ctx, at) {
    const wait = new Date(at).getTime() + 2 * SECOND_MS - Date.now();
    if (wait > 0) {
        ctx.progress('Waiting a moment, so the log backup starts after the chosen time');
        await sleep(wait);
    }
}

/** Copy mode: a LOG backup on the primary when the moment is newer than the newest log backup. */
function freshLogStep(db, at) {
    return {
        name: 'fresh_log',
        label: 'Take a log backup, if the moment is newer than the last one',
        check: (ctx) => (ctx.state.freshLogChecked ? (ctx.state.freshLogFileId ? `Backup #${ctx.state.freshLogFileId} already taken` : 'Not needed') : false),
        run: async (ctx) => {
            const plan = pointInTimePlan({ files: familyFiles(db), lineage: forks.lineage(db.id), at });
            if (!plan.problem || !/new log backup is needed/.test(plan.problem)) {
                ctx.save({ freshLogChecked: true });
                return 'Not needed: the backups already reach the moment';
            }
            await waitPastMoment(ctx, at);
            let started;
            for (let i = 0; ; i++) {
                try {
                    started = await startBackup(db.id, 'LOG', { trigger: 'point-in-time', parentId: ctx.op.id });
                    break;
                } catch (err) {
                    if (err instanceof BusyError && i < 120) {
                        ctx.progress('Waiting for a running backup to finish');
                        await sleep(5000);
                        continue;
                    }
                    throw err;
                }
            }
            const { operation, file } = await started.done;
            if (operation.status !== 'succeeded' || !file) throw new Error(`The log backup (operation #${operation.id}) failed: ${operation.error}`);
            ctx.save({ freshLogChecked: true, freshLogFileId: file.id });
            return `${started.type} backup #${file.id} ${file.rel_path}`;
        },
    };
}

// --- rollback ---------------------------------------------------------------------------

function rollbackSteps({ db, primaryServer, params, holder }) {
    const live = (server) => inspect.dbRestoreState(server.id, db.name);
    const at = params.at;
    const backOnline =
        `To keep ${db.name} as it was instead, run RESTORE DATABASE [${db.name}] WITH RECOVERY; and ALTER DATABASE [${db.name}] SET MULTI_USER; on ${primaryServer.name}, ` +
        'then mark this operation resolved.';
    return [
        {
            name: 'lock',
            label: `Wait until no backup or restore of ${db.name} is running`,
            guidance: LOCK_GUIDANCE,
            run: async (ctx) => {
                await holder.acquire(ctx);
                assertStillApplies(db, ctx.op, [primaryServer.id]);
                return 'Backups, restores and retention of this database are paused until the rollback is done';
            },
        },
        {
            name: 'validate',
            label: `Check ${db.name} on ${primaryServer.name}`,
            guidance: 'Nothing has changed yet. Fix the problem named in the error and resume, or mark the operation resolved.',
            check: (ctx) => (ctx.state.tailFileId ? 'Already checked' : false),
            run: async (ctx) => {
                const p = await live(primaryServer);
                if (!p || p.state !== 'ONLINE' || p.standby) throw new Error(`${db.name} is ${p ? p.state : 'missing'} on ${primaryServer.name}; a rollback needs it ONLINE`);
                const range = restorableRange({ files: familyFiles(db), lineage: forks.lineage(db.id) });
                if (!range.from || new Date(at).getTime() < new Date(range.from).getTime()) throw new Error(`${at} can no longer be restored: ${range.problem ?? `the oldest moment is ${range.from}`}`);
                forks.ensureRoot(db.id, p.recoveryForkGuid);
                ctx.save({ oldForkGuid: p.recoveryForkGuid });
                return `${db.name} is online on ${primaryServer.name}`;
            },
        },
        {
            name: 'tail_log',
            label: `Disconnect users and take a tail-log backup on ${primaryServer.name}`,
            guidance: `Users may be locked out of ${db.name} on ${primaryServer.name}. ${backOnline} If the error says the database is in use, another program grabbed the one allowed connection: resume to try again.`,
            check: async (ctx) => {
                if (ctx.state.tailFileId && backups.get(ctx.state.tailFileId)) return `Tail log #${ctx.state.tailFileId} already taken`;
                if (!ctx.state.tailRelPath) return false;
                const file = await catalogTail(db, primaryServer, ctx.state.tailRelPath, ctx.op.id);
                if (!file) return false;
                ctx.save({ tailFileId: file.id });
                return `The tail-log backup was taken before the interruption; recorded as #${file.id}`;
            },
            run: async (ctx) => {
                await waitPastMoment(ctx, at);
                ensureDir(primaryServer, backupRelDir(db.name, 'LOG'));
                const relPath = uniqueRelPath(db, 'LOG', primaryServer);
                ctx.save({ tailRelPath: relPath });
                const tail = P.tailLog({
                    db: db.name,
                    path: translatePath(relPath, primaryServer, pathOpts('rel', 'sql')),
                    name: 'Mostly-On tail-log (rollback)',
                    description: `mostly-on op:${ctx.op.id}`,
                    mode: 'planned',
                });
                await withDedicated(primaryServer.id, (q) => P.runOn(q, primaryServer.id, tail, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) }));
                const file = await catalogTail(db, primaryServer, relPath, ctx.op.id);
                if (!file) throw new Error(`SQL Server on ${primaryServer.name} has no record of the tail-log backup to ${relPath}`);
                ctx.save({ tailFileId: file.id });
                return `#${file.id} ${relPath}. Every change up to now is in the backups, including those after the moment`;
            },
        },
        {
            name: 'plan',
            label: 'Choose the backups to restore',
            guidance: `${db.name} on ${primaryServer.name} accepts no changes right now. If a backup file is missing, put it back on the share and resume. ${backOnline}`,
            check: (ctx) => (ctx.state.plan ? 'Already chosen' : false),
            run: (ctx) => makePlan(ctx, db, at),
        },
        {
            name: 'restore_primary',
            label: `Restore ${db.name} on ${primaryServer.name} to the moment`,
            guidance: `${db.name} on ${primaryServer.name} is being restored and accepts no changes. Fix the cause and resume; the backups from after the moment, including the tail-log backup, are still on the share.`,
            run: async (ctx) => {
                const files = planFiles(ctx);
                const moves = ctx.state.moves?.primary ?? (await placeInPlace(primaryServer, db.name, files.full));
                ctx.save({ moves: { ...(ctx.state.moves ?? {}), primary: moves } });
                const r = await restoreToMoment(ctx, { key: 'primary', server: primaryServer, name: db.name, files, at, moves, replace: true, priority: true });
                ctx.save({ stoppedAt: r.position, usedLogIds: r.logIds });
                return `${r.logIds.length} log backup(s) restored; stopped at LSN ${r.position}`;
            },
        },
        {
            name: 'recover',
            label: `Bring ${db.name} online on ${primaryServer.name} and let users in`,
            guidance: `${db.name} on ${primaryServer.name} is restored but not online yet. Resume to try again.`,
            check: async () => {
                const l = await live(primaryServer);
                if (!(l?.state === 'ONLINE' && !l.standby && l.userAccess === 'MULTI_USER')) return false;
                if ((await inspect.dbBackupState(primaryServer.id, db.name))?.ownedByService) return false;
                return `${db.name} is already online on ${primaryServer.name}`;
            },
            run: async (ctx) => {
                const owner = databases.get(db.id);
                const r = await P.run(primaryServer.id, P.recover({ db: db.name, ownerSid: owner?.owner_sid, ownerName: owner?.owner_name }), {
                    timeoutMs: 0,
                    onInfo: (m) => ctx.progress(m),
                    priority: true, // a rollback never waits for a free connection
                });
                const l = await live(primaryServer);
                if (l?.state !== 'ONLINE') throw new Error(`${db.name} is ${l?.state ?? 'missing'} on ${primaryServer.name} after recovery`);
                return `${db.name} is online on ${primaryServer.name}; ${ownerNote(db, primaryServer, owner, r.recordset[0], { category: 'restore', whose: `the owner of ${db.name}` })}`;
            },
        },
        {
            name: 'record_fork',
            label: 'Record the new branch of the database history',
            guidance: `${db.name} is online again. Resume to record its new branch of history; until then no backups run.`,
            run: async (ctx) => {
                const note = await recordFork(db, primaryServer, ctx);
                events.add('warn', 'restore', `${db.name} was rolled back to ${at} on ${primaryServer.name}`, { databaseId: db.id, serverId: primaryServer.id, operationId: ctx.op.id });
                publish('database.changed', { databaseId: db.id });
                return note;
            },
        },
        {
            name: 'secondaries',
            label: 'Restore the secondaries to the same moment',
            guidance: `${db.name} is online on ${primaryServer.name}. Resume to try the secondaries again; a secondary that cannot be restored is marked for reinitializing.`,
            run: (ctx) => rollbackSecondaries(ctx, db, at),
        },
        firstLogStep(db, primaryServer, holder, { trigger: 'point-in-time', what: 'rollback', category: 'restore' }),
    ];
}

/** MOVE targets for restoring `name` over itself on `server`. */
async function placeInPlace(server, name, full) {
    const s = serversRepo.get(server.id);
    const list = await inspect.fileList(server.id, translatePath(full.rel_path, s, pathOpts('rel', 'sql')));
    const current = await inspect.dbFiles(server.id, name);
    return inPlaceMoves(list, current, { defaultDataPath: s.default_data_path, defaultLogPath: s.default_log_path, dbName: name });
}

async function rollbackSecondaries(ctx, db, at) {
    const files = planFiles(ctx);
    const lineage = forks.lineage(db.id);
    const lines = [];
    const needsReseed = (r, why) => {
        databases.updateReplica(db.id, r.server_id, { chain_state: 'needs_reseed', chain_reason: `After the rollback to ${at}: ${why}` });
        events.add('error', 'restore', `${r.server_name} could not be restored to the moment ${db.name} was rolled back to (${why}). Reinitialize it (Reinitialize).`, {
            databaseId: db.id,
            serverId: r.server_id,
            operationId: ctx.op.id,
        });
        lines.push(`${r.server_name}: needs reinitializing (${why})`);
    };
    const results = await Promise.all(
        databases
            .replicas(db.id)
            .filter((r) => r.role === 'secondary' && !['needs_reseed', 'seeding'].includes(r.chain_state))
            .map(async (r) => {
                const key = `s${r.server_id}`;
                if (ctx.state.restored?.[key]?.done) return { r, ok: true, note: 'already restored' };
                const server = serversRepo.get(r.server_id);
                if (!health.getHealth(server.id)?.ok) return { r, ok: false, why: `${server.name} is unreachable` };
                try {
                    const moves = await placeInPlace(server, db.name, files.full);
                    const res = await restoreToMoment(ctx, { key, server, name: db.name, files, at, moves, replace: true, logIds: ctx.state.usedLogIds, priority: true });
                    const l = await inspect.dbRestoreState(server.id, db.name);
                    const off = lineageProblem({ position: l?.position, forkGuid: l?.forkGuid, lineage });
                    if (off) return { r, ok: false, why: off };
                    databases.updateReplica(db.id, r.server_id, {
                        chain_state: 'ok',
                        chain_reason: null,
                        position_lsn: l.position,
                        position_fork_guid: l.forkGuid,
                        last_restored_at: nowIso(),
                    });
                    ctx.save({ restored: { ...(ctx.state.restored ?? {}), [key]: { ...(ctx.state.restored?.[key] ?? {}), done: true } } });
                    publish('replica.changed', { databaseId: db.id, serverId: r.server_id });
                    return { r, ok: true, note: `at LSN ${res.position}` };
                } catch (err) {
                    return { r, ok: false, why: errText(err) };
                }
            }),
    );
    for (const x of results) {
        if (x.ok) lines.push(`${x.r.server_name}: restored to the moment (${x.note}); it continues from the next log backup`);
        else needsReseed(x.r, x.why);
    }
    return lines.join('; ') || 'No secondaries';
}

// --- starting and resuming -----------------------------------------------------------------

/**
 * Starts a point-in-time restore.
 *   mode 'copy':     { at, targetServerId, newName }
 *   mode 'rollback': { at, confirm } (confirm must be the database name)
 */
export async function startPointInTime(databaseId, { mode, at, targetServerId, newName, confirm, actor = null }) {
    if (!MODES.includes(mode)) throw fail(400, `mode must be one of ${MODES.join(', ')}`);
    const range = restoreRange(databaseId);
    const moment = checkMoment(range, at, { mode });
    const { db, primaryServer } = managedDb(databaseId);

    if (mode === 'copy') {
        const target = serversRepo.get(targetServerId);
        if (!target) throw fail(404, 'Choose the server to restore the copy on');
        if (!target.enabled) throw fail(409, `Server ${target.name} is disabled`);
        if (!health.getHealth(target.id)?.ok) throw fail(503, `${target.name} is unreachable`);
        const name = String(newName ?? '').trim();
        if (!NAME_RE.test(name)) throw fail(400, 'The new name may use letters, digits, _ and - (up to 100 characters)');
        if (name.toLowerCase() === db.name.toLowerCase()) throw fail(400, `The copy needs a name other than ${db.name}`);
        // Asked live: the health snapshot can be seconds old (a copy restored just now), and
        // SQL Server compares names without case. The snapshot is only a fallback.
        const existing = await inspect.dbRestoreState(target.id, name).catch(() => health.dbState(target.id, name));
        if (existing) throw fail(409, `A database named ${name} already exists on ${target.name}`);
        const params = { mode, at: moment, targetServerId: target.id, newName: name };
        const stepDefs = copySteps({ db, target, params });
        const operation = createOperation({ type: 'pitr_copy', databaseId: db.id, serverId: target.id, params, stepDefs, createdBy: actor });
        events.add('info', 'restore', `Restoring a copy of ${db.name} as it was at ${moment}: ${name} on ${target.name}`, {
            databaseId: db.id,
            serverId: target.id,
            operationId: operation.id,
            errorLog: [target.id],
        });
        return { operation, done: executeCopy(operation.id, stepDefs, db, params, target) };
    }

    if (confirm !== db.name) throw fail(400, `Type the database name (${db.name}) to confirm the rollback`);
    const params = { mode, at: moment, primaryServerId: primaryServer.id };
    const holder = lockHolder(db);
    const stepDefs = rollbackSteps({ db, primaryServer, params, holder });
    const operation = createOperation({ type: 'pitr_rollback', databaseId: db.id, serverId: primaryServer.id, params, stepDefs, createdBy: actor });
    events.add('warn', 'restore', `Rolling ${db.name} back to ${moment} on ${primaryServer.name} and its secondaries`, {
        databaseId: db.id,
        serverId: primaryServer.id,
        operationId: operation.id,
        errorLog: [primaryServer.id],
    });
    return { operation, done: executeRollback(operation.id, stepDefs, holder, db, params) };
}

function executeCopy(opId, stepDefs, db, params, target) {
    return runOperation(opId, stepDefs).then((op) => {
        if (op.status === 'succeeded') {
            events.add('info', 'restore', `${params.newName} on ${target.name} is ready: ${db.name} as it was at ${params.at}. Mostly-On does not back it up; drop it when you are done with it.`, {
                databaseId: db.id,
                serverId: target.id,
                operationId: op.id,
            });
        }
        return op;
    });
}

function executeRollback(opId, stepDefs, holder, db, params) {
    return runOperation(opId, stepDefs)
        .then((op) => {
            if (op.status === 'succeeded') {
                events.add('info', 'restore', `Rollback of ${db.name} to ${params.at} completed`, { databaseId: db.id, operationId: op.id, errorLog: [params.primaryServerId] });
            }
            publish('database.changed', { databaseId: db.id });
            return op;
        })
        .finally(() => {
            holder.release();
            nudgeDatabase(db.id);
        });
}

/** Re-runs a failed or interrupted point-in-time restore from its first unfinished step. */
export async function resumePointInTime(op, { actor = null } = {}) {
    const db = databases.get(op.database_id);
    if (!db || db.status !== 'managed') throw fail(409, 'The database is no longer managed');
    if (op.type === 'pitr_copy') {
        const target = serversRepo.get(op.params.targetServerId);
        if (!target) throw fail(409, 'The server no longer exists');
        const stepDefs = copySteps({ db, target, params: op.params });
        events.add('info', 'restore', `Resuming the copy of ${db.name} (#${op.id})`, { databaseId: db.id, serverId: target.id, operationId: op.id, actor });
        return { operation: op, done: executeCopy(op.id, stepDefs, db, op.params, target) };
    }
    const primaryServer = serversRepo.get(op.params.primaryServerId);
    if (!primaryServer) throw fail(409, 'The server no longer exists');
    // The lock is not held across runs: take it again before any other step.
    opsRepo.save(op.id, { steps: op.steps.map((s) => (s.name === 'lock' ? { ...s, status: 'pending', detail: undefined } : s)) });
    const holder = lockHolder(db);
    const stepDefs = rollbackSteps({ db, primaryServer, params: op.params, holder });
    events.add('warn', 'restore', `Resuming the rollback of ${db.name} (#${op.id})`, { databaseId: db.id, serverId: primaryServer.id, operationId: op.id, actor });
    return { operation: op, done: executeRollback(op.id, stepDefs, holder, db, op.params) };
}
