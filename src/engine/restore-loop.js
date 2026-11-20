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
import { nextLog, lag } from './chain.js';
import { restoreFile, fileOnDisk } from './restore.js';
import { backoffMs } from './restore-plan.js';
import { tryAcquire } from './locks.js';
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
 * (the user pressed "Restore now").
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
    const what = chainState === 'needs_reseed' ? 'needs a reseed' : 'stopped: the log chain is broken';
    events.add('error', 'restore', `Log shipping of ${db.name} to ${server.name} ${what}. ${reason}`, { databaseId: db.id, serverId: server.id, data: { chainState } });
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
        return { reseed: `Database ${db.name} on ${server.name} is a different database (family_guid ${live.familyGuid}, expected ${db.family_guid}).` };
    }
    if (!live.restoring) {
        if (live.state === 'ONLINE') return { reseed: `Database ${db.name} on ${server.name} was recovered (it is ONLINE and read-write) and cannot restore logs any more.` };
        return { retry: `Database ${db.name} on ${server.name} is ${live.state}` };
    }
    if (!live.position) return { retry: `SQL Server on ${server.name} reports no restore position for ${db.name}` };
    return null;
}

async function pass(dbId, serverId, w) {
    const db = databases.get(dbId);
    if (!db || db.status !== 'managed') return;
    let rep = databases.replica(dbId, serverId);
    if (!rep || rep.role !== 'secondary' || rep.chain_state !== 'ok') return;
    const server = serversRepo.get(serverId);
    if (!server?.enabled || !health.getHealth(serverId)?.ok) {
        waitingForServer.add(serverId); // woken by the next successful health check
        return;
    }

    const release = tryAcquire(dbId, `restore:${serverId}`);
    if (!release) return; // a seed or failover owns this secondary; the poll comes back
    w.lastPassAt = nowIso();
    let lastFileId = null;
    let restored = 0;
    try {
        for (let i = 0; i < MAX_RESTORES_PER_PASS; i++) {
            const live = await inspect.dbRestoreState(serverId, db.name);
            const problem = checkLive(db, server, live);
            if (problem?.reseed) return stopShipping(db, server, 'needs_reseed', problem.reseed);
            if (problem?.retry) throw new Error(problem.retry);

            if (!rep.position_lsn || !L.eq(rep.position_lsn, live.position) || rep.position_fork_guid !== live.forkGuid) {
                if (rep.position_lsn && !L.eq(rep.position_lsn, live.position)) {
                    events.add(
                        'warn',
                        'restore',
                        `${db.name} on ${server.name} is at LSN ${live.position} according to SQL Server, but the catalog expected ${rep.position_lsn}. Using SQL Server's position (was something restored outside Mostly On?).`,
                        { databaseId: db.id, serverId: server.id },
                    );
                }
                rep = databases.updateReplica(db.id, server.id, { position_lsn: live.position, position_fork_guid: live.forkGuid });
                changed(db, server);
            }

            const next = nextLog({ files: backups.all(db.id), position: live.position, forkGuid: live.forkGuid });
            if (next.status === 'caught_up') break;
            if (next.status === 'broken') return stopShipping(db, server, 'broken', next.reason);

            const file = next.file;
            if (file.id === lastFileId) {
                throw new Error(`Restoring ${file.rel_path} did not move ${db.name} on ${server.name} past LSN ${live.position}`);
            }
            if (!fileOnDisk(file)) return stopShipping(db, server, 'broken', `The next log backup ${file.rel_path} is missing from the backup volume.`);

            lastFileId = file.id;
            try {
                await restoreFile({ db, server, file, mode: rep.restore_mode, disconnectUsers: !!rep.disconnect_users });
            } catch (err) {
                if (err.restoreKind === 'already_applied') continue; // position is re-read; the guard above stops a loop
                if (err.restoreKind === 'too_recent') {
                    return stopShipping(db, server, 'broken', `SQL Server refused ${file.rel_path} as too recent: ${sqlErrorText(err)}`);
                }
                if (err.restoreKind === 'cannot_open' && !fileOnDisk(file)) {
                    return stopShipping(db, server, 'broken', `The next log backup ${file.rel_path} is missing from the backup volume.`);
                }
                throw err;
            }
            restored++;
            rep = databases.updateReplica(db.id, server.id, { position_lsn: file.last_lsn, last_restored_file_id: file.id, last_restored_at: nowIso() });
            changed(db, server);
            if (!rep || rep.role !== 'secondary' || rep.chain_state !== 'ok') return; // changed by a user meanwhile
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
    const now = new Date();
    for (const r of secondaries) {
        out.set(r.server_id, { ...lag({ files, position: r.position_lsn, now }), loop: loopStatus(dbId, r.server_id) });
    }
    return out;
}

function pollAll() {
    for (const db of databases.list()) {
        for (const r of databases.replicas(db.id)) {
            if (r.role === 'secondary' && r.chain_state === 'ok') nudge(db.id, r.server_id);
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
