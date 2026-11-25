// Automatic management (src/engine/auto-manage.js): which databases a pass
// manages, seeds and stops managing, and what it leaves alone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import { autoManagePlan } from '../../src/engine/auto-manage.js';
import { retentionPlan } from '../../src/engine/chain.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
beforeEach(() => closeDb());

const NOW = Date.parse('2026-11-25T12:00:00Z');
const MIN = 60_000;
const seen = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();
const disc = (name, minutesAgo = 10, extra = {}) => ({ name, system: false, state: 'ONLINE', first_seen_at: seen(minutesAgo), ...extra });
const db = (id, name, extra = {}) => ({ id, name, family_guid: `g${id}`, auto_seed: 0, hasSecondary: false, hasFull: true, busy: false, ...extra });
const live = (name, familyGuid) => ({ name, state: 'ONLINE', familyGuid });

function plan(p) {
    return autoManagePlan({ live: [], discovered: [], stoppedByPerson: new Set(), managed: [], target: null, missingSince: new Map(), now: NOW, settleMs: MIN, dropAfterMs: 30 * MIN, ...p });
}

test('user databases are managed once they have settled; system ones and those a person stopped are not', () => {
    const p = plan({
        discovered: [disc('Tenant1'), disc('Fresh', 0.5), disc('model', 10, { system: true }), disc('Stopped'), disc('Restoring', 10, { state: 'RESTORING' })],
        stoppedByPerson: new Set(['Stopped']),
    });
    assert.deepEqual(p.manage, ['Tenant1']);
});

test('a server with hundreds of databases is taken on a few at a time, oldest first', () => {
    const discovered = Array.from({ length: 12 }, (_, i) => disc(`T${String(i).padStart(2, '0')}`, 100 - i));
    assert.deepEqual(plan({ discovered }).manage, ['T00', 'T01', 'T02', 'T03', 'T04']);
});

test('a database managed automatically is seeded on the target once its FULL is there, a few at a time', () => {
    const managed = [db(1, 'A', { auto_seed: 1 }), db(2, 'B', { auto_seed: 1, hasFull: false }), db(3, 'C', { auto_seed: 1 }), db(4, 'D', { auto_seed: 1 }), db(5, 'E')];
    const liveDbs = managed.map((d) => live(d.name, d.family_guid));
    assert.deepEqual(plan({ managed, live: liveDbs, target: { ready: true, runningSeeds: 0 } }).seed, [1, 3], 'B waits for its FULL; two at a time; E was managed by hand');
    assert.deepEqual(plan({ managed, live: liveDbs, target: { ready: true, runningSeeds: 1 } }).seed, [1]);
    assert.deepEqual(plan({ managed, live: liveDbs, target: { ready: false, runningSeeds: 0 } }).seed, [], 'waits while the target is unreachable');
    assert.deepEqual(plan({ managed, live: liveDbs, target: null }).seed, [], 'no target: waits for one');
    const busy = [db(1, 'A', { auto_seed: 1, busy: true })];
    assert.deepEqual(plan({ managed: busy, live: [live('A', 'g1')], target: { ready: true, runningSeeds: 0 } }).seed, []);
    const has = [db(1, 'A', { auto_seed: 1, hasSecondary: true })];
    assert.deepEqual(plan({ managed: has, live: [live('A', 'g1')], target: { ready: true, runningSeeds: 0 } }).clearSeed, [1], 'already has a secondary: nothing to do');
});

test('a database gone from its server is dropped after the grace period, unless it comes back', () => {
    const managed = [db(1, 'Gone'), db(2, 'Here'), db(3, 'Recreated')];
    const liveDbs = [live('Here', 'g2'), live('Recreated', 'another')];
    const first = plan({ managed, live: liveDbs });
    assert.deepEqual([...first.missingSince], [[1, NOW], [3, NOW]], 'gone, and dropped then created again under the same name');
    assert.deepEqual(first.drop, []);

    const later = plan({ managed, live: liveDbs, missingSince: new Map([[1, NOW - 31 * MIN], [3, NOW - 10 * MIN]]) });
    assert.deepEqual(later.drop, [1]);

    const back = plan({ managed, live: [...liveDbs, live('Gone', 'g1')], missingSince: new Map([[1, NOW - 31 * MIN]]) });
    assert.deepEqual(back.drop, []);
    assert.equal(back.missingSince.has(1), false, 'back: no longer pending');

    const busy = plan({ managed: [db(1, 'Gone', { busy: true })], live: [], missingSince: new Map([[1, NOW - 31 * MIN]]) });
    assert.deepEqual(busy.drop, [], 'waits for a running operation');
});

test('stopping by a person, and by a drop, are told apart; managing again clears it', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const s1 = servers.create(servers.validate({ name: 'sql1', host: 'sql1', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const a = databases.manage({ name: 'A', familyGuid: null, primaryServerId: s1.id, autoSeed: true });
    const b = databases.manage({ name: 'B', familyGuid: null, primaryServerId: s1.id });
    assert.equal(databases.get(a.id).auto_seed, 1);
    databases.unmanage(a.id);
    databases.unmanage(b.id, { stoppedBy: 'dropped' });
    assert.deepEqual([...databases.stoppedByPersonOn(s1.id)], ['A']);
    assert.deepEqual(databases.listDropped().map((d) => d.name), ['B']);
    assert.equal(databases.get(a.id).auto_seed, 0);
    databases.manage({ name: 'A', familyGuid: null, primaryServerId: s1.id });
    assert.equal(databases.get(a.id).stopped_by, null);
    assert.deepEqual([...databases.stoppedByPersonOn(s1.id)], []);
});

test('a server ships to another one, which it forgets when that one is removed', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const [s1, s2] = [mk('sql1'), mk('sql2')];
    assert.equal(servers.get(s1.id).auto_manage, false);
    servers.setAutoManage(s1.id, { autoManage: true, shipTo: s2.id });
    assert.deepEqual([servers.get(s1.id).auto_manage, servers.get(s1.id).ship_to_server_id], [true, s2.id]);
    servers.setAutoManage(s1.id, { autoManage: false, shipTo: s2.id });
    assert.equal(servers.get(s1.id).ship_to_server_id, null, 'off: no target either');
    servers.setAutoManage(s1.id, { autoManage: true, shipTo: s2.id });
    servers.removeOrRetire(s2.id);
    assert.equal(servers.get(s1.id).ship_to_server_id, null);
});

test('retention removes every backup of a dropped database once it is old enough, the newest chain too', () => {
    const day = 86400_000;
    const f = (id, type, daysAgo, lsns = {}) => ({ id, type, file_status: 'present', backup_finish: new Date(NOW - daysAgo * day).toISOString(), first_lsn: '1', last_lsn: '2', ...lsns });
    const files = [f(1, 'FULL', 40), f(2, 'LOG', 39), f(3, 'FULL', 20), f(4, 'LOG', 2), f(5, 'DIVERGED', 90)];
    const retentionDays = { FULL: 28, DIFF: 14, LOG: 7 };
    const kept = retentionPlan({ files, secondaries: [], retentionDays, now: new Date(NOW) });
    assert.ok(!kept.deletable.some((x) => x.id === 3), 'a managed database keeps its newest FULL');
    const dropped = retentionPlan({ files, secondaries: [], retentionDays, now: new Date(NOW), dropped: true, extraProtected: new Set([2]) });
    assert.deepEqual(dropped.deletable.map((x) => x.id), [1], 'only what is past retention; files in use and safety backups stay');
    const later = retentionPlan({ files, secondaries: [], retentionDays, now: new Date(NOW + 30 * day), dropped: true });
    assert.deepEqual(later.deletable.map((x) => x.id), [1, 2, 3, 4], 'in time, the newest FULL goes too');
});
