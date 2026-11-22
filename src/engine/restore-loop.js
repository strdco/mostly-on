// Log shipping: one restore stream per (database, secondary).
//
// A pass reads the secondary's position from SQL Server (the source of truth
// for state), picks the log whose LSN range covers it (chain.nextLog),
// checks the file is on disk and restores it WITH NORECOVERY or STANDBY.
// It repeats until the secondary is caught up.
//
//  - A missing file or a gap in the chain marks the secondary "broken" and
//    stops it. Nothing is guessed; a user fixes the cause and rechecks, or
//    reseeds.
//  - A database that was recovered, dropped or replaced on the secondary is
//    marked "needs_reseed".
//  - Any other error is retried with backoff.
//  - A secondary with a restore delay only restores a log once that backup is
//    as old as the delay, and none while its restores are paused (pass() only;
//    failovers restore everything). A delayed copy is never a failover target.
//
// Passes are triggered by finished backups (bus) and by a poll timer. Each
// pass holds the restore:<serverId> lock, so a seed or failover on that
// secondary never overlaps with shipping.
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as events from '../store/repos/events.js';
import * as settings from '../store/repos/settings.js';
import * as inspect from '../sql/inspect.js';
import * as health from './health.js';
import * as L from '../lsn.js';
import * as forks from '../store/repos/forks.js';
import { nextLog, lag, lineageProblem } from './chain.js';
import { restoreFile, confirmOnDisk } from './restore.js';
import { backoffMs, logDueAt, isPaused, standbyUndoFile } from './restore-plan.js';
import { tryAcquire, exclusiveWaiting } from './locks.js';
import { subscribe, publish } from '../bus.js';
import { sqlErrorText } from '../sql/pool.js';
import { nowIso } from '../store/db.js';
import { log } from '../log.js';

const MAX_RESTORES_PER_PASS = 1000;

const workers = new Map(); // "dbId:serverId" -> worker state (in memory only)
const waitingForServer = new Set(); // servers skipped because they were disabled or unreachable
let timer = null;
let unsubscribe = null;
let started = false;

const keyOf = (dbId, serverId) => `${dbId}:${serverId}`;

function worker(dbId, serverId) {
    const k = keyOf(dbId, serverId);
    let w = workers.get(k);
    if (!w) {
        w = { running: false, again: false, failures: 0, retryAt: 0, lastError: null, lastPassAt: null };
        workers.set(k, w);
    }
    return w;
}

/** In-memory loop state of one secondary, for the API. */
export function loopStatus(dbId, serverId) {
    const w = workers.get(keyOf(dbId, serverId));
    if (!w) return null;
    return {
        running: w.running,
        failures: w.failures,
        retryAt: w.retryAt ? new Date(w.retryAt).toISOString() : null,
        lastError: w.lastError,
        lastPassAt: w.lastPassAt,
    };
}

/**
 * Requests a restore pass for one secondary. `force` skips the retry backoff
 * (the user pressed Recheck, or a seed just finished).
 */
export function nudge(dbId, serverId, { force = false } = {}) {
    if (!started) return;
    const w = worker(dbId, serverId);
    if (force) w.retryAt = 0;
    if (w.retryAt && Date.now() < w.retryAt) return;
    if (w.running) {
        w.again = true;
        return;
    }
    run(dbId, serverId, w);
}

export function nudgeDatabase(dbId) {
    for (const r of databases.replicas(dbId)) {
        if (r.role === 'secondary' && r.chain_state === 'ok') nudge(dbId, r.server_id);
    }
}

async function run(dbId, serverId, w) {
    w.running = true;
    try {
        do {
            w.again = false;
            await pass(dbId, serverId, w);
        } while (w.again && !(w.retryAt && Date.now() < w.retryAt));
    } catch (err) {
        log.error('Restore pass crashed', { databaseId: dbId, serverId, err });
    } finally {
        w.running = false;
    }
}

function changed(db, server) {
    publish('replica.changed', { databaseId: db.id, serverId: server.id });
}

function stopShipping(db, server, chainState, reason) {
    databases.updateReplica(db.id, server.id, { chain_state: chainState, chain_reason: reason });
    const what = chainState === 'needs_reseed' ? 'has stopped, and the copy there needs reinitializing (Reinitialize)' : 'has stopped';
    events.add('error', 'restore', `Shipping of ${db.name} to ${server.name} ${what}: ${reason}`, { databaseId: db.id, serverId: server.id, data: { chainState } });
    changed(db, server);
}

/**
 * Checks the live database on the secondary. Returns
 *   { reseed: reason }  the copy can never continue shipping
 *   { retry: reason }   a condition that may clear (OFFLINE, SUSPECT ...)
 *   null                fine
 */
export function checkLive(db, server, live) {
    if (!live) return { reseed: `Database ${db.name} does not exist on ${server.name}.` };
    if (db.family_guid && live.familyGuid && live.familyGuid !== db.family_guid) {
        return { reseed: `${db.name} on ${server.name} is a different database with the same name, not a copy of the primary (family_guid ${live.familyGuid}, expected ${db.family_guid}).` };
    }
    if (!live.restoring) {
        if (live.state === 'ONLINE') return { reseed: `${db.name} on ${server.name} was brought online (someone ran RESTORE ... WITH RECOVERY), so it can no longer receive log backups.` };
        return { retry: `${db.name} on ${server.name} is ${live.state}, not receiving logs` };
    }
    if (!live.position) return { retry: `SQL Server on ${server.name} reports no restore position for ${db.name}` };
    return null;
}

/**
 * Restores every log the secondary can take right now, in order. The caller
 * holds the restore:<server> or the exclusive lock. Used by the restore loop
 * and by failovers (catch-up, applying the tail).
 *
 * @param {{db:object, server:object, mode?:'norecovery'|'standby', operationId?:number|null, onProgress?:(t:string)=>void, honorDelay?:boolean}} p
 *   mode overrides the replica's restore mode (failovers always use NORECOVERY).
 *   Every log restore disconnects anyone reading a STANDBY copy first.
 *   priority (failovers and rollbacks): never wait for a free connection on the
 *   server. yieldToExclusive (the restore loop): while waiting for one, give
 *   way to a failover or rollback of the database ('yield').
 *   honorDelay (the restore loop only): stop at a log younger than the
 *   replica's restore delay ('delayed', with dueAt) or while it is paused
 *   ('paused'). Failovers leave it off: a failover restores every log there is.
 * @returns {Promise<{status:'caught_up'|'broken'|'reseed'|'stopped'|'readers'|'yield'|'more'|'delayed'|'paused', reason?:string, restored:number,
 *           position:string|null, forkGuid:string|null, lastFile:object|null}>}
 *   Throws on errors that are worth retrying (connection, unexpected SQL errors).
 */
export async function applyAvailableLogs({ db, server, mode = null, operationId = null, onProgress, yieldToExclusive = false, honorDelay = false, priority = false }) {
    let lastFileId = null;
    let lastFile = null;
    let restored = 0;
    const result = (status, extra = {}) => ({ status, restored, lastFile, position: null, forkGuid: null, ...extra });
    for (let i = 0; i < MAX_RESTORES_PER_PASS; i++) {
        let rep = databases.replica(db.id, server.id);
        if (!rep || rep.role !== 'secondary') return result('stopped', { reason: `${server.name} is no longer a secondary of ${db.name}` });

        const live = await inspect.dbRestoreState(server.id, db.name);
        const problem = checkLive(db, server, live);
        if (problem?.reseed) return result('reseed', { reason: problem.reseed });
        if (problem?.retry) throw new Error(problem.retry);
        const at = { position: live.position, forkGuid: live.forkGuid };

        if (!rep.position_lsn || !L.eq(rep.position_lsn, live.position) || rep.position_fork_guid !== live.forkGuid) {
            if (rep.position_lsn && !L.eq(rep.position_lsn, live.position)) {
                events.add(
                    'warn',
                    'restore',
                    `${db.name} on ${server.name} is not where Mostly-On expected it to be (was something restored there by hand?). Mostly-On continues from where SQL Server says it is.`,
                    { databaseId: db.id, serverId: server.id, data: { sqlServerLsn: live.position, expectedLsn: rep.position_lsn } },
                );
            }
            rep = databases.updateReplica(db.id, server.id, { position_lsn: live.position, position_fork_guid: live.forkGuid });
            changed(db, server);
        }

        const lineage = forks.lineage(db.id);
        const offPath = lineageProblem({ position: live.position, forkGuid: live.forkGuid, lineage });
        if (offPath) return result('reseed', { ...at, reason: `${db.name} on ${server.name} cannot follow the primary: ${offPath}.` });

        const next = nextLog({ files: backups.all(db.id), position: live.position, forkGuid: live.forkGuid, lineage });
        if (next.status === 'caught_up') return result('caught_up', at);
        if (next.status === 'broken') return result('broken', { ...at, reason: next.reason });

        const file = next.file;
        if (file.id === lastFileId) {
            throw new Error(`Restoring ${file.rel_path} did not move ${db.name} on ${server.name} past LSN ${live.position}`);
        }
        if (!(await confirmOnDisk(file))) return result('broken', { ...at, reason: `The next log backup ${file.rel_path} is missing from the backup volume.` });

        // Kept behind on purpose: wait until the log is as old as the delay (after
        // the on-disk check, so a missing file is still reported right away).
        if (honorDelay) {
            if (isPaused(rep)) return result('paused', at);
            const dueAt = logDueAt(file, rep.restore_delay_minutes);
            if (dueAt > Date.now()) return result('delayed', { ...at, dueAt });
        }

        // A failover is waiting for this database: stop between files; it restores the rest itself.
        if (yieldToExclusive && exclusiveWaiting(db.id)) return result('yield', at);
        lastFileId = file.id;
        onProgress?.(`Restoring ${file.rel_path} on ${server.name}`);
        const restoreMode = mode || rep.restore_mode;
        let undo = null;
        if (restoreMode === 'standby') {
            // Readable: keep its undo file, or start a new one if it is not readable yet. Recorded
            // first; an interrupted restore leaves the copy unreadable, so it simply starts another.
            undo = standbyUndoFile({ server, dbName: db.name, live, recorded: rep.standby_undo_file });
            if (undo !== rep.standby_undo_file) rep = databases.updateReplica(db.id, server.id, { standby_undo_file: undo });
        }
        try {
            await restoreFile({
                db,
                server,
                file,
                operationId,
                mode: restoreMode,
                undo,
                priority,
                onWait: onProgress,
                abortWhen: yieldToExclusive ? () => exclusiveWaiting(db.id) && `a failover or rollback of ${db.name} needs the database` : null,
            });
        } catch (err) {
            if (err.restoreKind === 'already_applied') continue;
            // Still waiting for a free connection when a failover asked for the database: it restores the rest itself.
            if (err.restoreKind === 'gave_way') return result('yield', at);
            // Someone reconnected in the instant between the disconnect and the restore: try again shortly.
            if (err.restoreKind === 'in_use') return result('readers', { ...at, reason: `Someone reconnected to ${db.name} on ${server.name} just as the restore started` }); // position is re-read; the guard above stops a loop
            if (err.restoreKind === 'too_recent') return result('broken', { ...at, reason: `SQL Server refused ${file.rel_path} as too recent: ${sqlErrorText(err)}` });
            if (err.restoreKind === 'wrong_fork') return result('reseed', { ...at, reason: `SQL Server refused ${file.rel_path} as being on another recovery path: ${sqlErrorText(err)}` });
            if (err.restoreKind === 'wrong_file') return result('broken', { ...at, reason: `${err.message} Or reinitialize ${server.name}.` });
            if (err.restoreKind === 'cannot_open' && !(await confirmOnDisk(file))) {
                return result('broken', { ...at, reason: `The next log backup ${file.rel_path} is missing from the backup volume.` });
            }
            throw err;
        }
        restored++;
        lastFile = file;
        databases.updateReplica(db.id, server.id, { position_lsn: file.last_lsn, last_restored_file_id: file.id, last_restored_at: nowIso() });
        changed(db, server);
    }
    return result('more');
}

async function pass(dbId, serverId, w) {
    const db = databases.get(dbId);
    if (!db || db.status !== 'managed') return;
    const rep = databases.replica(dbId, serverId);
    if (!rep || rep.role !== 'secondary' || rep.chain_state !== 'ok') return;
    const server = serversRepo.get(serverId);
    if (!server?.enabled || !health.getHealth(serverId)?.ok) {
        waitingForServer.add(serverId); // woken by the next successful health check
        return;
    }

    const release = tryAcquire(dbId, `restore:${serverId}`);
    if (!release) return; // a seed or failover owns this secondary; the poll comes back
    w.lastPassAt = nowIso();
    try {
        const r = await applyAvailableLogs({ db, server, yieldToExclusive: true, honorDelay: true });
        if (r.status === 'broken') return stopShipping(db, server, 'broken', r.reason);
        if (r.status === 'reseed') return stopShipping(db, server, 'needs_reseed', r.reason);
        if (r.status === 'stopped' || r.status === 'yield') return;
        if (r.status === 'readers') {
            // Not a failure: no backoff, the next poll (or backup) tries again.
            log.info('Restore deferred: a reader reconnected', { database: db.name, server: server.name });
            return;
        }
        if (r.status === 'more') w.again = true;
        const restored = r.restored;
        // 'delayed' and 'paused' are not failures: the next poll checks again.
        // Back where its delay says after a pause or a lowered delay: lag alerts apply again.
        if (r.status === 'delayed' || r.status === 'caught_up') {
            const now = databases.replica(dbId, serverId);
            if (now?.restores_paused_until && !isPaused(now)) {
                databases.updateReplica(dbId, serverId, { restores_paused_until: null });
                changed(db, server);
            }
        }

        if (w.failures) {
            events.add('info', 'restore', `Log shipping of ${db.name} to ${server.name} is working again`, { databaseId: db.id, serverId: server.id });
        }
        w.failures = 0;
        w.retryAt = 0;
        w.lastError = null;
        if (restored) log.debug('Restore pass finished', { database: db.name, server: server.name, restored });
    } catch (err) {
        const message = err.number || err.code ? sqlErrorText(err) : err.message;
        w.failures++;
        w.retryAt = Date.now() + backoffMs(w.failures);
        w.lastError = message;
        if (w.failures === 1 || w.failures % 10 === 0) {
            events.add(
                'error',
                'restore',
                `Restoring ${db.name} on ${server.name} failed${w.failures > 1 ? ` (${w.failures} attempts in a row)` : ''}: ${message}. Retrying in ${Math.round(backoffMs(w.failures) / 1000)} s.`,
                { databaseId: db.id, serverId: server.id },
            );
        }
        changed(db, server);
    } finally {
        release();
    }
}

/**
 * Lag of every secondary of a database (see chain.lag), plus loop state.
 * @returns {Map<number, object>} serverId -> { files, seconds, lastRestored, loop }
 */
export function lagOf(dbId, replicas) {
    const out = new Map();
    const secondaries = replicas.filter((r) => r.role !== 'primary');
    if (!secondaries.length) return out;
    const files = backups.all(dbId);
    const lineage = forks.lineage(dbId);
    const now = new Date();
    for (const r of secondaries) {
        out.set(r.server_id, { ...lag({ files, position: r.position_lsn, now, lineage }), loop: loopStatus(dbId, r.server_id) });
    }
    return out;
}

// Diverged copies that are ONLINE and writable: applications could be using
// the old primary while the new one is live (split brain). Logged once per
// occurrence; the split:<db>:<srv> alert (notify/alerts.js) sends the notifications.
const divergedOnline = new Set();

function watchDiverged(db, r) {
    const key = keyOf(db.id, r.server_id);
    const live = health.dbState(r.server_id, db.name);
    if (live && live.state === 'ONLINE' && !live.isInStandby) {
        if (divergedOnline.has(key)) return;
        divergedOnline.add(key);
        events.add(
            'error',
            'failover',
            `The old copy of ${db.name} on ${r.server_name}, out of sync since a failover, is online and accepts changes. Applications connected to it write to a database that is no longer the primary (split brain). Take it offline or reinitialize it.`,
            { databaseId: db.id, serverId: r.server_id },
        );
        publish('replica.changed', { databaseId: db.id, serverId: r.server_id });
    } else {
        divergedOnline.delete(key);
    }
}

export function divergedIsOnline(dbId, serverId) {
    return divergedOnline.has(keyOf(dbId, serverId));
}

function pollAll() {
    for (const db of databases.list()) {
        for (const r of databases.replicas(db.id)) {
            if (r.role === 'secondary' && r.chain_state === 'ok') nudge(db.id, r.server_id);
            else if (r.role === 'diverged') watchDiverged(db, r);
        }
    }
}

export function start() {
    if (started) return;
    started = true;
    unsubscribe = subscribe((evt) => {
        try {
            if (evt.type === 'backup.finished' && evt.payload.databaseId) {
                nudgeDatabase(evt.payload.databaseId);
            } else if (evt.type === 'server.health' && evt.payload.ok && waitingForServer.has(evt.payload.serverId)) {
                waitingForServer.delete(evt.payload.serverId);
                for (const r of databases.replicasOnServer(evt.payload.serverId)) {
                    if (r.role === 'secondary' && r.chain_state === 'ok') nudge(r.database_id, r.server_id);
                }
            }
        } catch (err) {
            log.error('Restore nudge failed', { err });
        }
    });
    const loop = () => {
        try {
            pollAll();
        } catch (err) {
            log.error('Restore poll failed', { err });
        }
        timer = setTimeout(loop, settings.get('restore.poll_seconds') * 1000);
        timer.unref?.();
    };
    timer = setTimeout(loop, 2000);
    timer.unref?.();
}

export function stop() {
    started = false;
    unsubscribe?.();
    clearTimeout(timer);
}
