// Automatic management, for servers with many databases that come and go
// (one per tenant). On a server with auto_manage on, after each health check:
//  - user databases Mostly-On does not manage yet are managed, once they have
//    been there a minute (an application may still be setting one up, say
//    switching it to FULL recovery). Not the ones a person stopped managing.
//  - one managed this way gets a secondary on the server's default target
//    (ship_to_server_id) once its first FULL backup is there. One try: if the
//    seed fails, a person adds the secondary by hand.
//  - a managed database that has been gone from the server for
//    auto_manage.drop_after_minutes is no longer managed: its copies nobody
//    can write to are dropped, and retention removes its backups in time.
//    While it is gone, it raises no alerts and its backups wait.
// Servers are usually set up in pairs (sql1 ships to sql2, sql2 to sql1), so
// after a switchover new databases are shipped back to the old primary.
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as ops from '../store/repos/operations.js';
import * as events from '../store/repos/events.js';
import * as settings from '../store/repos/settings.js';
import * as health from './health.js';
import { manageDatabase, stopManagingDropped } from './manage.js';
import { startSeed } from './ops/seed.js';
import { holders } from './locks.js';
import { subscribe } from '../bus.js';
import { log } from '../log.js';
import { dbLabel } from './backup-rules.js';

const SETTLE_MS = 60_000; // a new database is managed once it has been there this long
const MANAGE_PER_PASS = 5; // so a server with hundreds of unmanaged databases is taken on gradually
const SEEDS_PER_TARGET = 2; // new secondaries being seeded on one server at a time
const RETRY_FAILED_MANAGE_MS = 10 * 60_000;

// Integration tests only: shortens the settle time and the wait before a gone database is dropped.
const TEST_SECONDS = Number(process.env.MOSTLY_ON_TEST_AUTO_SECONDS) || null;

/** Database id -> { since (ms), serverId }: managed databases gone from their server. */
const missing = new Map();
const failedManage = new Map(); // "serverId:name" -> ms of the last failure
const running = new Set(); // server ids with a pass under way
let unsubscribe = null;

/** True while a database is gone from its server and about to stop being managed (no alerts, no backups meanwhile). */
export function pendingDrop(databaseId) {
    return missing.has(databaseId);
}

/**
 * What one pass does on a server, from its latest health check (pure).
 *   live        the databases on the server (health check)
 *   discovered  databases on it that Mostly-On does not manage: { name, system, state, first_seen_at }
 *   stoppedByPerson  names a person stopped managing (left alone)
 *   managed     databases whose primary is this server: { id, name, family_guid, auto_seed, hasSecondary, hasFull, busy }
 *   target      the default target: { ready, runningSeeds } or null
 *   missingSince  database id -> ms it was first seen gone
 * Returns { manage: names, seed: ids, clearSeed: ids, drop: ids, missingSince: the new map }.
 */
export function autoManagePlan({ live, discovered, stoppedByPerson, managed, target, missingSince, now, settleMs = SETTLE_MS, dropAfterMs, perPass = MANAGE_PER_PASS }) {
    const byName = new Map(live.map((d) => [d.name, d]));
    const plan = { manage: [], seed: [], clearSeed: [], drop: [], missingSince: new Map() };
    let seedRoom = target?.ready ? Math.max(0, SEEDS_PER_TARGET - target.runningSeeds) : 0;

    for (const db of managed) {
        const d = byName.get(db.name);
        // Dropped, or dropped and created again under the same name (another database).
        const gone = !d || (!!db.family_guid && !!d.familyGuid && d.familyGuid !== db.family_guid);
        if (gone) {
            const since = missingSince.get(db.id) ?? now;
            plan.missingSince.set(db.id, since);
            if (now - since >= dropAfterMs && !db.busy) plan.drop.push(db.id);
            continue;
        }
        if (!db.auto_seed) continue;
        if (db.hasSecondary) plan.clearSeed.push(db.id);
        else if (seedRoom > 0 && db.hasFull && !db.busy) {
            plan.seed.push(db.id);
            seedRoom--;
        }
    }

    plan.manage = discovered
        .filter((d) => !d.system && d.state === 'ONLINE' && !stoppedByPerson.has(d.name) && now - Date.parse(d.first_seen_at) >= settleMs)
        .sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || a.name.localeCompare(b.name))
        .slice(0, perPass)
        .map((d) => d.name);
    return plan;
}

function forgetServer(serverId) {
    for (const [id, m] of missing) if (m.serverId === serverId) missing.delete(id);
}

/** The default target of a server, as autoManagePlan() needs it (null if none). */
function targetOf(server) {
    if (!server.ship_to_server_id) return null;
    const t = serversRepo.get(server.ship_to_server_id);
    if (!t) return null;
    const h = health.getHealth(t.id);
    return {
        server: t,
        ready: t.enabled && !t.removed_at && !!h?.ok && h.setup?.ready !== false,
        runningSeeds: ops.unfinished().filter((o) => (o.type === 'seed' || o.type === 'reseed') && o.server_id === t.id).length,
    };
}

/** One pass on a server (see the top of this file). One at a time per server. */
export async function runPass(serverId, { now = Date.now() } = {}) {
    if (running.has(serverId)) return;
    running.add(serverId);
    try {
        const server = serversRepo.get(serverId);
        if (!server || !server.enabled || server.removed_at || !server.auto_manage) {
            forgetServer(serverId);
            return;
        }
        const h = health.getHealth(serverId);
        if (!h?.ok) return; // gone is only "gone" while the server answers

        const managed = databases
            .replicasOnServer(serverId)
            .filter((r) => r.role === 'primary')
            .map((r) => databases.get(r.database_id))
            .filter((db) => db?.status === 'managed')
            .map((db) => ({
                ...db,
                hasSecondary: databases.replicas(db.id).some((x) => x.role !== 'primary'),
                hasFull: !!backups.latestFull(db.id, db.family_guid),
                busy: holders(db.id).length > 0,
            }));
        const target = targetOf(server);
        const before = new Map([...missing].filter(([, m]) => m.serverId === serverId).map(([id, m]) => [id, m.since]));
        const plan = autoManagePlan({
            live: h.databases,
            discovered: databases.discovered().filter((d) => d.server_id === serverId),
            stoppedByPerson: databases.stoppedByPersonOn(serverId),
            managed,
            target,
            missingSince: before,
            now,
            settleMs: TEST_SECONDS ? TEST_SECONDS * 1000 : SETTLE_MS,
            dropAfterMs: (TEST_SECONDS ?? settings.get('auto_manage.drop_after_minutes') * 60) * 1000,
        });

        // Gone, and back again.
        const wait = TEST_SECONDS ? `${TEST_SECONDS} seconds` : `${settings.get('auto_manage.drop_after_minutes')} minutes`;
        for (const [id, since] of plan.missingSince) {
            if (!before.has(id)) {
                const db = managed.find((x) => x.id === id);
                events.add('info', 'database', `${dbLabel(db)} is gone from ${server.name}. Mostly-On stops managing it in ${wait} unless it comes back.`, { databaseId: id, serverId });
            }
            missing.set(id, { since, serverId });
        }
        for (const id of before.keys()) {
            if (plan.missingSince.has(id)) continue;
            missing.delete(id);
            const db = managed.find((x) => x.id === id);
            if (db) events.add('info', 'database', `${dbLabel(db)} is back on ${server.name}; Mostly-On keeps managing it.`, { databaseId: id, serverId });
        }

        for (const id of plan.drop) {
            const db = managed.find((x) => x.id === id);
            try {
                if (await stopManagingDropped(db, server.name)) missing.delete(id);
            } catch (err) {
                log.error('Could not stop managing a dropped database', { database: db.name, err });
            }
        }

        for (const id of plan.clearSeed) databases.clearAutoSeed(id);
        for (const id of plan.seed) {
            const db = managed.find((x) => x.id === id);
            databases.clearAutoSeed(id); // one try
            try {
                await startSeed(id, { serverId: target.server.id, source: 'latest', restoreMode: 'norecovery' });
            } catch (err) {
                events.add('warn', 'seed', `Mostly-On could not give ${db.name} a secondary on ${target.server.name} automatically: ${err.message} Add it by hand on the database page.`, {
                    databaseId: id,
                    serverId: target.server.id,
                });
            }
        }

        if (h.setup && !h.setup.ready) return; // nothing could be backed up yet
        for (const name of plan.manage) {
            const key = `${serverId}:${name}`;
            if (now - (failedManage.get(key) ?? -Infinity) < RETRY_FAILED_MANAGE_MS) continue;
            try {
                const { warning } = await manageDatabase({ serverId, name, trigger: 'auto', autoSeed: true });
                failedManage.delete(key);
                if (warning) log.warn('Automatic management: first FULL backup did not start', { database: name, warning });
            } catch (err) {
                if (!failedManage.has(key)) {
                    events.add('warn', 'database', `Mostly-On could not start managing ${name} on ${server.name} automatically: ${err.message} It tries again every ${RETRY_FAILED_MANAGE_MS / 60_000} minutes.`, { serverId });
                }
                failedManage.set(key, now);
            }
        }
    } finally {
        running.delete(serverId);
    }
}

/** Runs a pass after each successful health check (after discovery, which subscribes first). */
export function start() {
    unsubscribe = subscribe((evt) => {
        if (evt.type !== 'server.health') return;
        if (!evt.payload.ok) return;
        runPass(evt.payload.serverId).catch((err) => log.error('Automatic management failed', { err }));
    });
}

export function stop() {
    unsubscribe?.();
    unsubscribe = null;
}

/** Tests only. */
export function _reset() {
    missing.clear();
    failedManage.clear();
    running.clear();
}
