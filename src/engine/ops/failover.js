// Planned and forced failover.
//
// Both are journaled operations (engine/operations.js): every step checks the
// servers before it acts, so a failed or interrupted failover can be resumed
// by a user. Nothing is ever rolled back automatically.
//
// Planned (the primary is healthy):
//   lock, validate, catch_up, tail_log (SINGLE_USER + BACKUP LOG WITH
//   NORECOVERY on the old primary), restore_tail, recover, multi_user,
//   swap_roles (old primary becomes a secondary), first_log
//
// Forced (the primary is unavailable, or the user chose no tail-log backup):
//   lock, validate, tail_log (best effort, never fails) or offline_old (no
//   tail log: set the old copy OFFLINE if reachable, never fails), apply_logs
//   (stops at a gap), recover (+ MULTI_USER), swap_roles (old primary becomes
//   diverged), other_secondaries (continue or need a reseed), first_log
//
// The UI has one Failover button; startFailover() picks the kind.
//
// The operation holds the database's exclusive lock until the roles are
// swapped; the first log backup runs after it is released.
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as backups from '../../store/repos/backups.js';
import * as forks from '../../store/repos/forks.js';
import * as events from '../../store/repos/events.js';
import * as opsRepo from '../../store/repos/operations.js';
import * as inspect from '../../sql/inspect.js';
import * as Q from '../../sql/tsql.js';
import * as health from '../health.js';
import * as L from '../../lsn.js';
import { query, withDedicated, T, sqlErrorText } from '../../sql/pool.js';
import { createOperation, runOperation } from '../operations.js';
import { acquire, BusyError } from '../locks.js';
import { applyAvailableLogs, checkLive, nudgeDatabase } from '../restore-loop.js';
import { startBackup, recordBackupFile, ensureDir, uniqueRelPath } from '../backup.js';
import { reachable, lineageProblem, lag, onLineage } from '../chain.js';
import { restoreCompatibility } from '../../sqlversion.js';
import { translatePath, backupRelDir } from '../../paths.js';
import { pathOpts } from '../context.js';
import { publish } from '../../bus.js';

const LOCK_WAIT_MS = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(status, message, details) {
    return Object.assign(new Error(message), { status, expose: true, details });
}

function errText(err) {
    return err.number || err.code ? sqlErrorText(err) : err.message;
}

/** The exclusive lock, shared by the steps of one run (and released before first_log). */
function lockHolder(db) {
    let release = null;
    return {
        async acquire(ctx) {
            if (release) return;
            ctx?.progress('Waiting for running backups and restores to finish');
            release = await acquire(db.id, 'exclusive', { timeoutMs: LOCK_WAIT_MS });
        },
        release() {
            release?.();
            release = null;
        },
    };
}

/** applyAvailableLogs until it stops for a reason other than "more to do" (one pass stops after 1000 logs). */
async function applyAll(args) {
    let r;
    let restored = 0;
    do {
        r = await applyAvailableLogs(args);
        restored += r.restored;
    } while (r.status === 'more');
    return { ...r, restored };
}

// --- shared validation and preview -------------------------------------------------

function loadTopology(databaseId, targetServerId) {
    const db = databases.get(databaseId);
    if (!db || db.status !== 'managed') throw fail(404, 'Database is not managed');
    const primary = databases.primaryOf(db.id);
    if (!primary) throw fail(409, `${db.name} has no primary`);
    const target = serversRepo.get(targetServerId);
    if (!target) throw fail(404, 'Server not found');
    if (target.id === primary.server_id) throw fail(409, `${target.name} is already the primary of ${db.name}`);
    if (!target.enabled) throw fail(409, `Server ${target.name} is disabled; enable it before failing over to it`);
    const rep = databases.replica(db.id, target.id);
    if (!rep || rep.role !== 'secondary') throw fail(409, `${target.name} is not a secondary of ${db.name}`);
    return { db, primary, oldServer: serversRepo.get(primary.server_id), target, rep };
}

/**
 * What a failover to `targetServerId` would involve, including the
 * estimated data-loss window of a forced failover.
 */
export async function failoverPreview(databaseId, targetServerId) {
    const { db, oldServer, target, rep } = loadTopology(databaseId, targetServerId);
    const ph = health.getHealth(oldServer.id);
    const th = health.getHealth(target.id);
    // Ask the primary directly: the health snapshot can be a poll behind (e.g. just after a failover).
    let primaryLive = ph?.ok ? health.dbState(oldServer.id, db.name) : null;
    if (ph?.ok) {
        try {
            const p = await inspect.dbRestoreState(oldServer.id, db.name);
            primaryLive = p ? { state: p.state, isInStandby: p.standby } : null;
        } catch {
            /* keep the snapshot */
        }
    }
    let live = null;
    let targetError = null;
    if (th?.ok) {
        try {
            live = await inspect.dbRestoreState(target.id, db.name);
        } catch (err) {
            targetError = errText(err);
        }
    } else {
        targetError = `${target.name} is unreachable`;
    }

    const files = backups.all(db.id);
    const lineage = forks.lineage(db.id);
    const position = live?.position || rep.position_lsn;
    const forkGuid = live?.forkGuid || rep.position_fork_guid;
    const reach = position ? reachable({ files, position, forkGuid, lineage }) : null;
    const landed = reach?.lastFile || (position ? lag({ files, position, lineage }).lastRestored : null);
    const landedFinish = landed?.backup_finish ? backups.get(landed.id)?.backup_finish || landed.backup_finish : null;
    const newestLog = files
        .filter((f) => f.type === 'LOG' && onLineage(f, lineage))
        .reduce((a, b) => (!a || (b.backup_finish || '') > (a.backup_finish || '') ? b : a), null);

    const others = [];
    for (const r of databases.replicas(db.id)) {
        if (r.role !== 'secondary' || r.server_id === target.id) continue;
        const after = reach?.position && r.position_lsn && L.gt(r.position_lsn, reach.position);
        others.push({
            server: r.server_name,
            position: r.position_lsn,
            continues: !after,
            note: after ? `has restored past LSN ${reach.position} and would need a reseed after a forced failover` : 'continues shipping from the new primary',
        });
    }
    const back = restoreCompatibility(th?.info?.majorVersion, ph?.info?.majorVersion ?? th?.info?.majorVersion);
    const problem = live ? checkLive(db, target, live) : null;
    const primaryState = primaryLive ? (primaryLive.isInStandby ? 'STANDBY' : primaryLive.state) : null;
    // Why a lossless (planned) failover is not possible, or null when it is.
    let plannedBlocker = null;
    if (!ph?.ok) plannedBlocker = `${oldServer.name} was unreachable at the last check${ph?.error ? ` (${ph.error})` : ''}`;
    else if (primaryState !== 'ONLINE') plannedBlocker = `${db.name} is ${primaryState ?? 'missing'} on ${oldServer.name}`;
    else if (rep.chain_state !== 'ok') plannedBlocker = `shipping to ${target.name} is ${rep.chain_state}`;
    else if (reach?.gap) plannedBlocker = `the log chain to ${target.name} has a gap`;
    else if (problem) plannedBlocker = problem.reseed || problem.retry;
    else if (targetError) plannedBlocker = targetError;
    return {
        database: { id: db.id, name: db.name },
        oldPrimary: { id: oldServer.id, name: oldServer.name, reachable: !!ph?.ok, checkedAt: ph?.checkedAt ?? null, state: primaryState },
        target: {
            id: target.id,
            name: target.name,
            reachable: !!th?.ok,
            error: targetError || problem?.reseed || problem?.retry || null,
            state: live ? (live.standby ? 'STANDBY' : live.state) : null,
            chainState: rep.chain_state,
            position,
        },
        chain: {
            logsToApply: reach?.files ?? null,
            endsAt: reach?.position ?? null,
            gap: reach?.gap ?? null,
            newestLogFinish: newestLog?.backup_finish ?? null,
        },
        dataLoss: {
            // Everything committed on the old primary after this point is lost unless the tail-log backup succeeds.
            since: landedFinish,
            seconds: landedFinish ? Math.max(0, Math.round((Date.now() - new Date(landedFinish).getTime()) / 1000)) : null,
        },
        otherSecondaries: others,
        oldPrimaryCanFollow: back.ok ? null : back.reason,
        plannedPossible: !plannedBlocker,
        plannedBlocker,
    };
}

/**
 * The single entry point of the UI's Failover dialog. With a tail-log backup
 * it is a planned failover when that is possible (nothing is lost; the old
 * primary continues as a secondary), and otherwise a forced failover with a
 * best-effort tail. Without one it is a forced failover that sets the old
 * primary's copy OFFLINE if it can reach it. Every path that may lose data
 * needs acceptDataLoss, so a primary that went down after the dialog opened
 * cannot silently turn a lossless failover into a lossy one.
 */
export async function startFailover(databaseId, { serverId, tailLog, acceptDataLoss }) {
    if (tailLog) {
        const pf = await failoverPreview(databaseId, serverId);
        if (pf.plannedPossible) return startPlannedFailover(databaseId, { serverId });
        if (acceptDataLoss !== true) throw fail(409, `A failover without data loss is no longer possible (${pf.plannedBlocker}). Reopen the dialog to see what may be lost.`);
        return startForcedFailover(databaseId, { serverId, acceptDataLoss, tailLog: 'best_effort' });
    }
    return startForcedFailover(databaseId, { serverId, acceptDataLoss, tailLog: 'none' });
}

// --- shared steps ---------------------------------------------------------------------

function lockStep(holder, db) {
    return {
        name: 'lock',
        label: `Wait until no backup or restore of ${db.name} is running`,
        guidance: 'Something kept the database busy for 30 minutes (a long backup or seed?). Check Operations, then resume.',
        run: async (ctx) => {
            await holder.acquire(ctx);
            return 'Backups, restores and retention of this database are paused until the roles are swapped';
        },
    };
}

/** Records the fork the recovered copy is on as a child of the lineage tip. */
async function recordFork(db, server, ctx) {
    const live = await inspect.dbRestoreState(server.id, db.name);
    if (!live?.recoveryForkGuid) throw new Error(`${server.name} reports no recovery fork for ${db.name}`);
    if (ctx.state.oldForkGuid) forks.ensureRoot(db.id, ctx.state.oldForkGuid);
    const tip = forks.tip(db.id);
    if (tip === live.recoveryForkGuid) return `Recovery fork ${live.recoveryForkGuid} is already recorded`;
    forks.addChild(db.id, { forkGuid: live.recoveryForkGuid, parentForkGuid: tip, forkPointLsn: live.forkPointLsn, operationId: ctx.op.id });
    return `New recovery fork ${live.recoveryForkGuid} branches off ${tip} at LSN ${live.forkPointLsn}`;
}

function recoverStep(db, target) {
    return {
        name: 'recover',
        label: `RESTORE DATABASE ... WITH RECOVERY on ${target.name}, then MULTI_USER`,
        guidance: `${db.name} on ${target.name} could not be recovered. Read the error; once it is fixed, resume. Until then no server accepts writes for ${db.name}.`,
        check: async () => {
            const live = await inspect.dbRestoreState(target.id, db.name);
            return live?.state === 'ONLINE' && !live.standby && live.userAccess === 'MULTI_USER' ? `${db.name} is already ONLINE and MULTI_USER on ${target.name}` : false;
        },
        run: async (ctx) => {
            let live = await inspect.dbRestoreState(target.id, db.name);
            const notes = [];
            if (live?.restoring) {
                await query(target.id, Q.RESTORE_WITH_RECOVERY, { db: T.sysname(db.name) }, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) });
                notes.push('recovered');
                live = await inspect.dbRestoreState(target.id, db.name);
            }
            if (live?.state !== 'ONLINE') throw new Error(`${db.name} is ${live?.state ?? 'missing'} on ${target.name} after recovery`);
            if (live.userAccess !== 'MULTI_USER') {
                await query(target.id, Q.SET_MULTI_USER, { db: T.sysname(db.name) }, { timeoutMs: 120_000 });
                notes.push(`${live.userAccess} → MULTI_USER`);
            }
            return `${db.name} on ${target.name}: ${notes.join(', ') || 'already ONLINE'}`;
        },
    };
}

function firstLogStep(db, target, holder) {
    return {
        name: 'first_log',
        label: `First LOG backup on the new primary ${target.name}`,
        check: (ctx) => (ctx.state.postLogFileId ? `Backup #${ctx.state.postLogFileId} already taken` : false),
        run: async (ctx) => {
            holder.release();
            nudgeDatabase(db.id);
            let started;
            try {
                for (let i = 0; ; i++) {
                    try {
                        started = await startBackup(db.id, 'LOG', { trigger: 'failover', parentId: ctx.op.id });
                        break;
                    } catch (err) {
                        if (err instanceof BusyError && i < 24) {
                            await sleep(5000);
                            continue;
                        }
                        throw err;
                    }
                }
            } catch (err) {
                return `Could not start it (${err.message}). The failover itself is complete; the LOG schedule takes the next backup.`;
            }
            const { operation, file } = await started.done;
            if (operation.status !== 'succeeded' || !file) {
                return `It failed (${operation.error}). The failover itself is complete; the LOG schedule takes the next backup.`;
            }
            ctx.save({ postLogFileId: file.id });
            return `${started.type} backup #${file.id} ${file.rel_path}${await verifyForkCrossing(db, target, file)}`;
        },
    };
}

/** Cross-checks msdb's fork GUIDs of a log that crosses a fork with RESTORE HEADERONLY. */
async function verifyForkCrossing(db, server, file) {
    if (!file.first_recovery_fork_guid || file.first_recovery_fork_guid === file.recovery_fork_guid) return '';
    try {
        const [h] = await inspect.headerOnly(server.id, translatePath(file.rel_path, server, pathOpts('rel', 'sql')));
        if (h && h.firstRecoveryForkGuid === file.first_recovery_fork_guid && h.recoveryForkGuid === file.recovery_fork_guid) {
            return ' (crosses the fork; fork GUIDs confirmed with RESTORE HEADERONLY)';
        }
        events.add('error', 'failover', `RESTORE HEADERONLY of ${file.rel_path} reports different recovery forks than msdb. Secondaries may not be able to cross the fork.`, {
            databaseId: db.id,
            serverId: server.id,
            data: { msdb: { first: file.first_recovery_fork_guid, last: file.recovery_fork_guid }, header: h },
        });
        return ' (WARNING: RESTORE HEADERONLY disagrees with msdb about the recovery forks)';
    } catch (err) {
        return ` (could not verify the fork GUIDs with RESTORE HEADERONLY: ${errText(err)})`;
    }
}

async function catalogTail(db, server, relPath, opId) {
    const existing = backups.byRelPath(relPath);
    if (existing) return existing;
    const bs = await inspect.backupsetByPath(server.id, db.name, translatePath(relPath, server, pathOpts('rel', 'sql')));
    if (!bs) return null;
    return recordBackupFile({ db, server, bs, relPath, operationId: opId, isTail: true });
}

// --- planned failover ----------------------------------------------------------------

function plannedSteps({ db, oldServer, target, holder }) {
    const live = (server) => inspect.dbRestoreState(server.id, db.name);
    return [
        lockStep(holder, db),
        {
            name: 'validate',
            label: `Check ${oldServer.name} and ${target.name}`,
            guidance: `Nothing has changed yet; ${oldServer.name} is still the primary. Fix the problem named in the error and resume, or mark the operation resolved.`,
            run: async (ctx) => {
                const p = await live(oldServer);
                if (!p || p.state !== 'ONLINE' || p.standby) throw new Error(`${db.name} is ${p ? p.state : 'missing'} on ${oldServer.name}; a planned failover needs it ONLINE (fail over without a tail-log backup instead)`);
                const t = await live(target);
                const problem = checkLive(db, target, t);
                if (problem) throw new Error(problem.reseed || problem.retry);
                const off = lineageProblem({ position: t.position, forkGuid: t.forkGuid, lineage: forks.lineage(db.id) });
                if (off) throw new Error(`${target.name} cannot become the primary: ${off}`);
                forks.ensureRoot(db.id, p.recoveryForkGuid);
                ctx.save({ oldForkGuid: p.recoveryForkGuid });
                return `${db.name} is ONLINE on ${oldServer.name} and ${t.standby ? 'STANDBY' : 'RESTORING'} on ${target.name} at LSN ${t.position}`;
            },
        },
        {
            name: 'catch_up',
            label: `Restore every available log on ${target.name}`,
            guidance: `Nothing has changed on ${oldServer.name}; it is still the primary. Fix the cause (a missing log file puts the chain back with Recheck), then resume.`,
            run: async (ctx) => {
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m) });
                if (r.status !== 'caught_up') throw new Error(r.reason || `Restore stopped (${r.status})`);
                return `${r.restored} log(s) restored; ${target.name} is at LSN ${r.position}`;
            },
        },
        {
            name: 'tail_log',
            label: `Tail-log backup on ${oldServer.name} (SINGLE_USER, then BACKUP LOG WITH NORECOVERY)`,
            guidance:
                `${db.name} on ${oldServer.name} may now be in SINGLE_USER mode. To keep ${oldServer.name} as the primary instead, run ALTER DATABASE … SET MULTI_USER there and mark this operation resolved. ` +
                `If the error says the database is in use, another session took the single-user connection: resume to try again.`,
            check: async (ctx) => {
                if (ctx.state.tailFileId && backups.get(ctx.state.tailFileId)) return `Tail log #${ctx.state.tailFileId} already taken`;
                if (!ctx.state.tailRelPath) return false;
                const file = await catalogTail(db, oldServer, ctx.state.tailRelPath, ctx.op.id);
                if (!file) return false;
                ctx.save({ tailFileId: file.id });
                return `The tail log was taken before the interruption; cataloged as #${file.id}`;
            },
            run: async (ctx) => {
                ensureDir(oldServer, backupRelDir(db.name, 'LOG'));
                const relPath = uniqueRelPath(db, 'LOG', oldServer);
                ctx.save({ tailRelPath: relPath });
                const params = {
                    db: T.sysname(db.name),
                    path: T.nvarchar(translatePath(relPath, oldServer, pathOpts('rel', 'sql'))),
                    name: T.nvarchar('Mostly On tail-log', 128),
                    description: T.nvarchar(`mostly-on op:${ctx.op.id}`, 255),
                };
                await withDedicated(oldServer.id, (q) => q(Q.TAIL_LOG_PLANNED, params, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) }));
                const file = await catalogTail(db, oldServer, relPath, ctx.op.id);
                if (!file) throw new Error(`The tail-log backup to ${relPath} is not in msdb on ${oldServer.name}`);
                ctx.save({ tailFileId: file.id });
                return `#${file.id} ${relPath} (up to LSN ${file.last_lsn}); ${db.name} on ${oldServer.name} is RESTORING`;
            },
        },
        {
            name: 'restore_tail',
            label: `Restore the tail log on ${target.name}`,
            guidance:
                `${db.name} is RESTORING on ${oldServer.name} and on ${target.name}: no server accepts writes right now. Fix the cause and resume. ` +
                `To go back to ${oldServer.name} instead, run RESTORE DATABASE … WITH RECOVERY and SET MULTI_USER there, then mark this operation resolved.`,
            check: async (ctx) => {
                const tail = backups.get(ctx.state.tailFileId);
                const t = await live(target);
                return tail && t?.restoring && t.position && L.gte(t.position, tail.last_lsn) ? `${target.name} is already at LSN ${t.position}` : false;
            },
            run: async (ctx) => {
                const tail = backups.get(ctx.state.tailFileId);
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m) });
                if (!r.position || L.lt(r.position, tail.last_lsn)) {
                    throw new Error(`${target.name} stopped at LSN ${r.position}, before the end of the tail log (${tail.last_lsn}): ${r.reason || r.status}`);
                }
                return `${target.name} is at LSN ${r.position}, the end of the tail log`;
            },
        },
        recoverStep(db, target),
        {
            name: 'swap_roles',
            label: `Make ${target.name} the primary and ${oldServer.name} a secondary`,
            guidance: `${db.name} is live on ${target.name}. Resume to record the new roles; until then the catalog still names ${oldServer.name} as primary and no backups run.`,
            check: () => (databases.primaryOf(db.id)?.server_id === target.id ? `${target.name} is already the primary` : false),
            run: async (ctx) => {
                const forkNote = await recordFork(db, target, ctx);
                const o = await live(oldServer).catch(() => null);
                const back = restoreCompatibility(health.getHealth(target.id)?.info?.majorVersion, health.getHealth(oldServer.id)?.info?.majorVersion);
                const patch = { position_lsn: o?.position ?? null, position_fork_guid: o?.forkGuid ?? null };
                if (!back.ok) Object.assign(patch, { chain_state: 'needs_reseed', chain_reason: back.reason });
                databases.swapPrimary(db.id, { newPrimaryId: target.id, oldPrimaryId: oldServer.id, oldPrimaryRole: 'secondary', oldPrimaryPatch: patch });
                events.add('warn', 'failover', `${target.name} is now the primary of ${db.name}; ${oldServer.name} is a secondary`, { databaseId: db.id, serverId: target.id, operationId: ctx.op.id });
                publish('database.changed', { databaseId: db.id });
                return `${forkNote}. ${oldServer.name} continues as a secondary from LSN ${o?.position ?? '?'}`;
            },
        },
        firstLogStep(db, target, holder),
    ];
}

/**
 * Validates and starts a planned failover (switchover) to a secondary.
 * Resolves once the operation exists; `done` settles when it has finished.
 */
export async function startPlannedFailover(databaseId, { serverId, parentId = null }) {
    const { db, oldServer, target, rep } = loadTopology(databaseId, serverId);
    if (rep.chain_state !== 'ok') throw fail(409, `Shipping to ${target.name} is ${rep.chain_state}; a planned failover needs a healthy secondary`);
    if (!health.getHealth(oldServer.id)?.ok) throw fail(409, `The primary ${oldServer.name} is unreachable; fail over without a tail-log backup instead`);
    if (!health.getHealth(target.id)?.ok) throw fail(503, `${target.name} is unreachable`);
    const holder = lockHolder(db);
    const stepDefs = plannedSteps({ db, oldServer, target, holder });
    const operation = createOperation({
        type: 'planned_failover',
        databaseId: db.id,
        serverId: target.id,
        parentId,
        params: { targetServerId: target.id, oldPrimaryServerId: oldServer.id },
        stepDefs,
    });
    events.add('warn', 'failover', `Planned failover of ${db.name} from ${oldServer.name} to ${target.name} started`, { databaseId: db.id, serverId: target.id, operationId: operation.id });
    return { operation, done: execute(operation.id, stepDefs, holder, db) };
}

// --- forced failover ----------------------------------------------------------------

/** Forced failover without a tail-log backup: keep the old copy from taking writes. */
function offlineOldStep(db, oldServer) {
    return {
        name: 'offline_old',
        label: `Set ${db.name} OFFLINE on ${oldServer.name} if it is reachable (no tail-log backup)`,
        check: (ctx) => (ctx.state.offlineAttempted ? `Already attempted: ${ctx.state.offlineResult}` : false),
        run: async (ctx) => {
            let result;
            try {
                await withDedicated(oldServer.id, (q) => q(Q.SET_OFFLINE, { db: T.sysname(db.name) }, { timeoutMs: 120_000 }), { connectTimeoutMs: 5000 });
                result = `${db.name} on ${oldServer.name} is OFFLINE; nothing can write to it`;
            } catch (err) {
                result = `Could not set it OFFLINE (${errText(err)}); continuing. If ${oldServer.name} comes back with ${db.name} ONLINE, use Take offline in the Replicas table`;
            }
            ctx.save({ offlineAttempted: true, offlineResult: result });
            return result;
        },
    };
}

function forcedSteps({ db, oldServer, target, holder, tailLog = 'best_effort' }) {
    const live = (server) => inspect.dbRestoreState(server.id, db.name);
    return [
        lockStep(holder, db),
        {
            name: 'validate',
            label: `Check ${target.name}`,
            guidance: `Nothing has changed yet. Fix the problem named in the error and resume, or mark the operation resolved.`,
            run: async (ctx) => {
                const t = await live(target);
                const problem = checkLive(db, target, t);
                if (problem) throw new Error(problem.reseed || problem.retry);
                const off = lineageProblem({ position: t.position, forkGuid: t.forkGuid, lineage: forks.lineage(db.id) });
                if (off) throw new Error(`${target.name} cannot become the primary: ${off}`);
                forks.ensureRoot(db.id, t.forkGuid);
                ctx.save({ oldForkGuid: t.forkGuid });
                return `${db.name} is ${t.standby ? 'STANDBY' : 'RESTORING'} on ${target.name} at LSN ${t.position}`;
            },
        },
        tailLog === 'none' ? offlineOldStep(db, oldServer) : {
            name: 'tail_log',
            label: `Best-effort tail-log backup on ${oldServer.name} (NO_TRUNCATE, NORECOVERY)`,
            check: (ctx) => {
                if (!ctx.state.tailAttempted) return false;
                return ctx.state.tailFileId ? `Tail log #${ctx.state.tailFileId} already taken` : `Already attempted: ${ctx.state.tailError}`;
            },
            run: async (ctx) => {
                try {
                    ensureDir(oldServer, backupRelDir(db.name, 'LOG'));
                    const relPath = ctx.state.tailRelPath || uniqueRelPath(db, 'LOG', oldServer);
                    ctx.save({ tailRelPath: relPath });
                    const params = {
                        db: T.sysname(db.name),
                        path: T.nvarchar(translatePath(relPath, oldServer, pathOpts('rel', 'sql'))),
                        name: T.nvarchar('Mostly On forced tail-log', 128),
                        description: T.nvarchar(`mostly-on op:${ctx.op.id}`, 255),
                    };
                    const attempt = (continueAfterError) =>
                        withDedicated(oldServer.id, (q) => q(Q.tailLogForced({ continueAfterError }), params, { timeoutMs: 300_000, onInfo: (m) => ctx.progress(m) }), {
                            connectTimeoutMs: 5000,
                        });
                    try {
                        await attempt(false);
                    } catch (err) {
                        if (!err.number) throw err; // could not connect: no point retrying
                        ctx.progress(`Tail-log backup failed (${errText(err)}); retrying WITH CONTINUE_AFTER_ERROR`);
                        await attempt(true);
                    }
                    const file = await catalogTail(db, oldServer, relPath, ctx.op.id);
                    if (!file) throw new Error(`the backup to ${relPath} is not in msdb on ${oldServer.name}`);
                    ctx.save({ tailAttempted: true, tailFileId: file.id });
                    return `Tail log #${file.id} taken (up to LSN ${file.last_lsn}); ${db.name} on ${oldServer.name} is now RESTORING`;
                } catch (err) {
                    const message = errText(err);
                    ctx.save({ tailAttempted: true, tailError: message });
                    return `No tail-log backup (${message}); continuing without it`;
                }
            },
        },
        {
            name: 'apply_logs',
            label: `Restore every available log on ${target.name}`,
            guidance: `Nothing has been recovered yet. Fix the cause and resume, or mark the operation resolved.`,
            run: async (ctx) => {
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m) });
                if (!['caught_up', 'broken'].includes(r.status)) throw new Error(r.reason || `Restore stopped (${r.status}); resume to try again`);
                const files = backups.all(db.id);
                const landed = lag({ files, position: r.position, lineage: forks.lineage(db.id) }).lastRestored;
                ctx.save({ gap: r.status === 'broken' ? r.reason : null, recoveredAt: r.position, dataUpTo: landed?.backup_finish ?? null });
                const upTo = landed?.backup_finish ? `; data up to the backup finished at ${landed.backup_finish}` : '';
                return `${r.restored} log(s) restored; ${target.name} is at LSN ${r.position}${upTo}${r.status === 'broken' ? `. Stopped at a gap: ${r.reason}` : ''}`;
            },
        },
        recoverStep(db, target),
        {
            name: 'swap_roles',
            label: `Make ${target.name} the primary and mark ${oldServer.name} as diverged`,
            guidance: `${db.name} is live on ${target.name}. Resume to record the new roles; until then the catalog still names ${oldServer.name} as primary and no backups run.`,
            check: () => (databases.primaryOf(db.id)?.server_id === target.id ? `${target.name} is already the primary` : false),
            run: async (ctx) => {
                const forkNote = await recordFork(db, target, ctx);
                databases.swapPrimary(db.id, {
                    newPrimaryId: target.id,
                    oldPrimaryId: oldServer.id,
                    oldPrimaryRole: 'diverged',
                    oldPrimaryPatch: { chain_reason: `Forced failover #${ctx.op.id} to ${target.name}: this copy may hold transactions that ${target.name} does not have` },
                });
                events.add('warn', 'failover', `${target.name} is now the primary of ${db.name}; ${oldServer.name} holds a diverged copy and must be reseeded`, {
                    databaseId: db.id,
                    serverId: target.id,
                    operationId: ctx.op.id,
                });
                publish('database.changed', { databaseId: db.id });
                return `${forkNote}. ${oldServer.name} is marked diverged`;
            },
        },
        {
            name: 'other_secondaries',
            label: 'Check the other secondaries against the new recovery path',
            run: async () => {
                const lineage = forks.lineage(db.id);
                const lines = [];
                for (const r of databases.replicas(db.id)) {
                    if (r.role !== 'secondary') continue;
                    let pos = r.position_lsn;
                    let fork = r.position_fork_guid;
                    try {
                        const l = await inspect.dbRestoreState(r.server_id, db.name);
                        if (l?.restoring) ({ position: pos, forkGuid: fork } = l);
                    } catch {
                        /* unreachable: decide on the catalog's position; the restore loop re-checks later */
                    }
                    const problem = lineageProblem({ position: pos, forkGuid: fork, lineage });
                    if (problem) {
                        databases.updateReplica(db.id, r.server_id, { chain_state: 'needs_reseed', chain_reason: `After forced failover: ${problem}` });
                        events.add('error', 'failover', `${r.server_name} cannot follow the new primary of ${db.name}: ${problem}. Reseed it.`, { databaseId: db.id, serverId: r.server_id });
                        lines.push(`${r.server_name}: needs a reseed`);
                    } else {
                        lines.push(`${r.server_name}: continues from LSN ${pos}`);
                    }
                }
                return lines.join('; ') || 'No other secondaries';
            },
        },
        firstLogStep(db, target, holder),
    ];
}

/** Validates and starts a forced failover to a secondary. */
export async function startForcedFailover(databaseId, { serverId, acceptDataLoss, tailLog = 'best_effort' }) {
    const { db, oldServer, target, rep } = loadTopology(databaseId, serverId);
    if (acceptDataLoss !== true) throw fail(400, 'Confirm that transactions not yet shipped to the target may be lost');
    if (!['ok', 'broken'].includes(rep.chain_state)) throw fail(409, `${target.name} is ${rep.chain_state} and cannot become the primary`);
    if (!health.getHealth(target.id)?.ok) throw fail(503, `${target.name} is unreachable`);
    const holder = lockHolder(db);
    const stepDefs = forcedSteps({ db, oldServer, target, holder, tailLog });
    const operation = createOperation({
        type: 'forced_failover',
        databaseId: db.id,
        serverId: target.id,
        params: { targetServerId: target.id, oldPrimaryServerId: oldServer.id, tailLog },
        stepDefs,
    });
    const how = tailLog === 'none' ? 'without a tail-log backup' : 'with a best-effort tail-log backup';
    events.add('warn', 'failover', `Forced failover of ${db.name} from ${oldServer.name} to ${target.name} ${how} started`, { databaseId: db.id, serverId: target.id, operationId: operation.id });
    return { operation, done: execute(operation.id, stepDefs, holder, db) };
}

// --- running and resuming ------------------------------------------------------------

function execute(opId, stepDefs, holder, db) {
    return runOperation(opId, stepDefs)
        .then((op) => {
            if (op.status === 'succeeded') {
                const p = databases.primaryOf(db.id);
                events.add('info', 'failover', `${op.type === 'forced_failover' ? 'Forced' : 'Planned'} failover of ${db.name} completed; ${p?.server_name} is the primary`, {
                    databaseId: db.id,
                    serverId: p?.server_id,
                    operationId: op.id,
                });
            }
            publish('database.changed', { databaseId: db.id });
            return op;
        })
        .finally(() => {
            holder.release();
            nudgeDatabase(db.id);
        });
}

/** Re-runs a failed or interrupted failover from its first unfinished step. */
export async function resumeFailover(op) {
    const db = databases.get(op.database_id);
    const oldServer = serversRepo.get(op.params.oldPrimaryServerId);
    const target = serversRepo.get(op.params.targetServerId);
    if (!db || db.status !== 'managed' || !oldServer || !target) throw fail(409, 'The database or one of the servers no longer exists');
    // The lock is not held across runs: take it again before any other step.
    const steps = op.steps.map((s) => (s.name === 'lock' ? { ...s, status: 'pending', detail: undefined } : s));
    opsRepo.save(op.id, { steps });
    const holder = lockHolder(db);
    const stepDefs = (op.type === 'forced_failover' ? forcedSteps : plannedSteps)({ db, oldServer, target, holder, tailLog: op.params.tailLog });
    events.add('warn', 'failover', `Resuming ${op.type.replace('_', ' ')} #${op.id} of ${db.name}`, { databaseId: db.id, serverId: target.id, operationId: op.id });
    return { operation: op, done: execute(op.id, stepDefs, holder, db) };
}
