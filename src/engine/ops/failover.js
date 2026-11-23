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
import * as P from '../../sql/privileged.js';
import * as health from '../health.js';
import * as L from '../../lsn.js';
import { withDedicated } from '../../sql/pool.js';
import { createOperation, runOperation } from '../operations.js';
import { applyAvailableLogs, checkLive, nudgeDatabase } from '../restore-loop.js';
import { ensureDir, uniqueRelPath } from '../backup.js';
import { fail, errText, lockHolder, recordFork, ownerNote, firstLogStep, catalogTail, assertStillApplies, restoreDelayProblem, LOCK_GUIDANCE } from './shared.js';
import { reachable, lineageProblem, lag, onLineage } from '../chain.js';
import { restoreCompatibility } from '../../sqlversion.js';
import { translatePath, backupRelDir } from '../../paths.js';
import { isBackupOnly, dbLabel } from '../backup-rules.js';
import { pathOpts } from '../context.js';
import { publish } from '../../bus.js';

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
    if (isBackupOnly(db)) throw fail(409, `Mostly-On only backs up ${dbLabel(db)}: it has no secondaries to fail over to.`);
    const primary = databases.primaryOf(db.id);
    if (!primary) throw fail(409, `${db.name} has no primary`);
    const target = serversRepo.get(targetServerId);
    if (!target) throw fail(404, 'Server not found');
    if (target.id === primary.server_id) throw fail(409, `${target.name} is already the primary of ${db.name}`);
    if (!target.enabled) throw fail(409, `Server ${target.name} is disabled; enable it before failing over to it`);
    const rep = databases.replica(db.id, target.id);
    if (!rep || rep.role !== 'secondary') throw fail(409, `${target.name} is not a secondary of ${db.name}`);
    const delayed = restoreDelayProblem(rep); // never a failover to a copy kept behind on purpose
    if (delayed) throw fail(409, delayed);
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
            note: after ? `has more of the primary's changes than ${target.name}; if the failover loses data, it will need reinitializing` : 'keeps receiving log backups, from the new primary',
        });
    }
    const back = restoreCompatibility(th?.info?.majorVersion, ph?.info?.majorVersion ?? th?.info?.majorVersion);
    const problem = live ? checkLive(db, target, live) : null;
    const primaryState = primaryLive ? (primaryLive.isInStandby ? 'STANDBY' : primaryLive.state) : null;
    // Why a lossless (planned) failover is not possible, or null when it is.
    let plannedBlocker = null;
    if (!ph?.ok) plannedBlocker = `${oldServer.name} was unreachable at the last check${ph?.error ? ` (${ph.error})` : ''}`;
    else if (primaryState !== 'ONLINE') plannedBlocker = `${db.name} is not online on ${oldServer.name} (${primaryState ?? 'missing'})`;
    else if (rep.chain_state !== 'ok') plannedBlocker = `shipping to ${target.name} has stopped`;
    else if (reach?.gap) plannedBlocker = `a log backup that ${target.name} needs is missing`;
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

function lockStep(holder, db, oldServer, target) {
    return {
        name: 'lock',
        label: `Wait until no backup or restore of ${db.name} is running`,
        guidance: LOCK_GUIDANCE,
        run: async (ctx) => {
            await holder.acquire(ctx);
            // The primary is the old one, or the target once this failover swapped the roles.
            assertStillApplies(db, ctx.op, [oldServer.id, target.id]);
            const rep = databases.replica(db.id, target.id);
            if (!['secondary', 'primary'].includes(rep?.role)) {
                throw new Error(`${target.name} no longer holds a working secondary of ${db.name}, so it cannot take over. Mark this operation resolved.`);
            }
            // A delay set after this failover stopped: resuming must not promote the copy (null once it is the primary).
            const delayed = restoreDelayProblem(rep);
            if (delayed) throw new Error(`${delayed} Then resume, or mark this operation resolved.`);
            return 'Backups, restores and retention of this database are paused until the roles are swapped';
        },
    };
}

function recoverStep(db, target) {
    return {
        name: 'recover',
        label: `Bring ${db.name} online on ${target.name} and let users in`,
        guidance: `${db.name} on ${target.name} could not be recovered. Read the error; once it is fixed, resume. Until then no server accepts writes for ${db.name}.`,
        check: async () => {
            const live = await inspect.dbRestoreState(target.id, db.name);
            if (!(live?.state === 'ONLINE' && !live.standby && live.userAccess === 'MULTI_USER')) return false;
            // Recovered, but interrupted before the owner was set: run again (it skips what is done).
            if ((await inspect.dbBackupState(target.id, db.name))?.ownedByService) return false;
            return `${db.name} is already online on ${target.name}`;
        },
        run: async (ctx) => {
            const owner = databases.get(db.id);
            const r = await P.run(target.id, P.recover({ db: db.name, ownerSid: owner?.owner_sid, ownerName: owner?.owner_name }), {
                timeoutMs: 0,
                priority: true, // failovers never wait for a free connection
                onInfo: (m) => ctx.progress(m),
            });
            const live = await inspect.dbRestoreState(target.id, db.name);
            if (live?.state !== 'ONLINE') throw new Error(`${db.name} is ${live?.state ?? 'missing'} on ${target.name} after recovery`);
            return `${db.name} is online on ${target.name}; ${ownerNote(db, target, owner, r.recordset[0])}`;
        },
    };
}

// --- planned failover ----------------------------------------------------------------

function plannedSteps({ db, oldServer, target, holder }) {
    const live = (server) => inspect.dbRestoreState(server.id, db.name);
    return [
        lockStep(holder, db, oldServer, target),
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
                return `${db.name} is online on ${oldServer.name}, and ${target.name} is ready to take over`;
            },
        },
        {
            name: 'catch_up',
            label: `Restore every available log on ${target.name}`,
            guidance: `Nothing has changed on ${oldServer.name}; it is still the primary. Fix the cause (if a log backup file is missing, put it back and press Try again on the database page), then resume.`,
            run: async (ctx) => {
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m), priority: true });
                if (r.status !== 'caught_up') throw new Error(r.reason || `Restore stopped (${r.status})`);
                return `${r.restored} log backup(s) restored on ${target.name}`;
            },
        },
        {
            name: 'tail_log',
            label: `Disconnect users and take the tail-log backup on ${oldServer.name}`,
            guidance:
                `Users may now be locked out of ${db.name} on ${oldServer.name} (SINGLE_USER). To keep ${oldServer.name} as the primary instead, let them back in by running ` +
                `ALTER DATABASE [${db.name}] SET MULTI_USER; on ${oldServer.name}, then mark this operation resolved. ` +
                `If the error says the database is in use, another program grabbed the one allowed connection: resume to try again.`,
            check: async (ctx) => {
                if (ctx.state.tailFileId && backups.get(ctx.state.tailFileId)) return `Tail log #${ctx.state.tailFileId} already taken`;
                if (!ctx.state.tailRelPath) return false;
                const file = await catalogTail(db, oldServer, ctx.state.tailRelPath, ctx.op.id);
                if (!file) return false;
                ctx.save({ tailFileId: file.id });
                return `The tail-log backup was taken before the interruption; recorded as #${file.id}`;
            },
            run: async (ctx) => {
                ensureDir(oldServer, backupRelDir(db.name, 'LOG'));
                const relPath = uniqueRelPath(db, 'LOG', oldServer);
                ctx.save({ tailRelPath: relPath });
                const tail = P.tailLog({
                    db: db.name,
                    path: translatePath(relPath, oldServer, pathOpts('rel', 'sql')),
                    name: 'Mostly-On tail-log',
                    description: `mostly-on op:${ctx.op.id}`,
                    mode: 'planned',
                });
                await withDedicated(oldServer.id, (q) => P.runOn(q, oldServer.id, tail, { timeoutMs: 0, onInfo: (m) => ctx.progress(m) }));
                const file = await catalogTail(db, oldServer, relPath, ctx.op.id);
                if (!file) throw new Error(`SQL Server on ${oldServer.name} has no record of the tail-log backup to ${relPath}`);
                ctx.save({ tailFileId: file.id });
                return `#${file.id} ${relPath}. ${db.name} on ${oldServer.name} no longer accepts changes`;
            },
        },
        {
            name: 'restore_tail',
            label: `Restore the tail-log backup on ${target.name}`,
            guidance:
                `Right now neither ${oldServer.name} nor ${target.name} accepts changes to ${db.name}. Fix the cause and resume. ` +
                `To go back to ${oldServer.name} instead, run RESTORE DATABASE [${db.name}] WITH RECOVERY; and then ALTER DATABASE [${db.name}] SET MULTI_USER; on ${oldServer.name}, and mark this operation resolved.`,
            check: async (ctx) => {
                const tail = backups.get(ctx.state.tailFileId);
                const t = await live(target);
                return tail && t?.restoring && t.position && L.gte(t.position, tail.last_lsn) ? `${target.name} is already at LSN ${t.position}` : false;
            },
            run: async (ctx) => {
                const tail = backups.get(ctx.state.tailFileId);
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m), priority: true });
                if (!r.position || L.lt(r.position, tail.last_lsn)) {
                    throw new Error(`${target.name} could not restore all of the tail-log backup: ${r.reason || r.status} (at LSN ${r.position}, needs ${tail.last_lsn})`);
                }
                return `${target.name} has every transaction from ${oldServer.name}`;
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
                return `${forkNote}. ${oldServer.name} is now a secondary`;
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
    if (rep.chain_state !== 'ok') throw fail(409, `Shipping to ${target.name} has stopped, so a failover without data loss is not possible`);
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
    events.add('warn', 'failover', `Failover of ${db.name} from ${oldServer.name} to ${target.name} started (with a tail-log backup: no data loss)`, { databaseId: db.id, serverId: target.id, operationId: operation.id });
    return { operation, done: execute(operation.id, stepDefs, holder, db) };
}

// --- forced failover ----------------------------------------------------------------

/** Forced failover without a tail-log backup: keep the old copy from taking writes. */
function offlineOldStep(db, oldServer) {
    return {
        name: 'offline_old',
        label: `Take ${db.name} offline on ${oldServer.name}, if it can be reached, so nothing keeps writing to it`,
        check: (ctx) => (ctx.state.offlineAttempted ? `Already attempted: ${ctx.state.offlineResult}` : false),
        run: async (ctx) => {
            let result;
            try {
                await withDedicated(oldServer.id, (q) => P.runOn(q, oldServer.id, P.setState({ db: db.name, state: 'OFFLINE' }), { timeoutMs: 120_000 }), { connectTimeoutMs: 5000 });
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
        lockStep(holder, db, oldServer, target),
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
                return `${target.name} is ready to take over`;
            },
        },
        tailLog === 'none' ? offlineOldStep(db, oldServer) : {
            name: 'tail_log',
            label: `Try a tail-log backup on ${oldServer.name} (best effort)`,
            check: (ctx) => {
                if (!ctx.state.tailAttempted) return false;
                return ctx.state.tailFileId ? `Tail log #${ctx.state.tailFileId} already taken` : `Already attempted: ${ctx.state.tailError}`;
            },
            run: async (ctx) => {
                try {
                    ensureDir(oldServer, backupRelDir(db.name, 'LOG'));
                    const relPath = ctx.state.tailRelPath || uniqueRelPath(db, 'LOG', oldServer);
                    ctx.save({ tailRelPath: relPath });
                    const tail = (continueAfterError) =>
                        P.tailLog({
                            db: db.name,
                            path: translatePath(relPath, oldServer, pathOpts('rel', 'sql')),
                            name: 'Mostly-On forced tail-log',
                            description: `mostly-on op:${ctx.op.id}`,
                            mode: 'forced',
                            continueAfterError,
                        });
                    const attempt = (continueAfterError) =>
                        withDedicated(oldServer.id, (q) => P.runOn(q, oldServer.id, tail(continueAfterError), { timeoutMs: 300_000, onInfo: (m) => ctx.progress(m) }), {
                            connectTimeoutMs: 5000,
                        });
                    try {
                        await attempt(false);
                    } catch (err) {
                        if (!err.number) throw err; // could not connect: no point retrying
                        ctx.progress(`Tail-log backup failed (${errText(err)}); retrying and skipping damaged pages (CONTINUE_AFTER_ERROR)`);
                        await attempt(true);
                    }
                    const file = await catalogTail(db, oldServer, relPath, ctx.op.id);
                    if (!file) throw new Error(`SQL Server on ${oldServer.name} has no record of the backup to ${relPath}`);
                    ctx.save({ tailAttempted: true, tailFileId: file.id });
                    return `Tail-log backup #${file.id} taken; ${db.name} on ${oldServer.name} no longer accepts changes`;
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
                const r = await applyAll({ db, server: target, mode: 'norecovery', operationId: ctx.op.id, onProgress: (m) => ctx.progress(m), priority: true });
                if (!['caught_up', 'broken'].includes(r.status)) throw new Error(r.reason || `Restore stopped (${r.status}); resume to try again`);
                const files = backups.all(db.id);
                const landed = lag({ files, position: r.position, lineage: forks.lineage(db.id) }).lastRestored;
                ctx.save({ gap: r.status === 'broken' ? r.reason : null, recoveredAt: r.position, dataUpTo: landed?.backup_finish ?? null });
                const upTo = landed?.backup_finish ? `; it has the data up to ${landed.backup_finish}` : '';
                return `${r.restored} log backup(s) restored on ${target.name}${upTo}${r.status === 'broken' ? `. A log backup is missing, so it stops there: ${r.reason}` : ''}`;
            },
        },
        recoverStep(db, target),
        {
            name: 'swap_roles',
            label: `Make ${target.name} the primary; mark ${oldServer.name} as out of sync`,
            guidance: `${db.name} is live on ${target.name}. Resume to record the new roles; until then the catalog still names ${oldServer.name} as primary and no backups run.`,
            check: () => (databases.primaryOf(db.id)?.server_id === target.id ? `${target.name} is already the primary` : false),
            run: async (ctx) => {
                const forkNote = await recordFork(db, target, ctx);
                databases.swapPrimary(db.id, {
                    newPrimaryId: target.id,
                    oldPrimaryId: oldServer.id,
                    oldPrimaryRole: 'diverged',
                    oldPrimaryPatch: { chain_reason: `After failover #${ctx.op.id} to ${target.name}, this copy may hold transactions that ${target.name} does not have` },
                });
                events.add('warn', 'failover', `${target.name} is now the primary of ${db.name}; the copy on ${oldServer.name} is out of sync and must be reinitialized (Reinitialize)`, {
                    databaseId: db.id,
                    serverId: target.id,
                    operationId: ctx.op.id,
                });
                publish('database.changed', { databaseId: db.id });
                return `${forkNote}. ${oldServer.name} is marked out of sync`;
            },
        },
        {
            name: 'other_secondaries',
            label: 'Check that the other secondaries can follow the new primary',
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
                        databases.updateReplica(db.id, r.server_id, { chain_state: 'needs_reseed', chain_reason: `After the failover, ${problem}` });
                        events.add('error', 'failover', `${r.server_name} cannot follow the new primary of ${db.name}: ${problem}. Reinitialize it (Reinitialize).`, { databaseId: db.id, serverId: r.server_id });
                        lines.push(`${r.server_name}: needs reinitializing`);
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
    if (!['ok', 'broken'].includes(rep.chain_state)) throw fail(409, `${target.name} cannot become the primary: ${rep.chain_state === 'seeding' ? 'it is still being set up' : 'its copy needs reinitializing'}`);
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
    events.add('warn', 'failover', `Failover of ${db.name} from ${oldServer.name} to ${target.name} ${how} started (data may be lost)`, { databaseId: db.id, serverId: target.id, operationId: operation.id });
    return { operation, done: execute(operation.id, stepDefs, holder, db) };
}

// --- running and resuming ------------------------------------------------------------

function execute(opId, stepDefs, holder, db) {
    return runOperation(opId, stepDefs)
        .then((op) => {
            if (op.status === 'succeeded') {
                const p = databases.primaryOf(db.id);
                events.add('info', 'failover', `Failover of ${db.name} completed; ${p?.server_name} is the primary`, {
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
