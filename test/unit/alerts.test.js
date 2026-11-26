// Alert dedupe state machine and message batching (notify/alert-state.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemo, decide, formatBatch } from '../../src/notify/alert-state.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-21T10:00:00Z');
const opts = { reminderMs: 4 * HOUR, confirmMs: MIN, resolveMs: MIN };

const cond = (key, message = `${key} is broken`, severity = 'error') => ({ key, kind: key.split(':')[0], severity, message, databaseId: 1, serverId: 2, link: null });

/** Runs the machine like alerts.js does: applies writes, and marks notices delivered when `delivered`. */
function harness() {
    const rows = new Map();
    const memo = createMemo();
    return {
        rows,
        step(now, conditions, { delivered = true } = {}) {
            const out = decide({ conditions: new Map(conditions.map((c) => [c.key, c])), rows: new Map(rows), memo, now, ...opts });
            for (const w of out.writes) rows.set(w.key, { ...w });
            if (delivered) for (const n of out.notices) rows.get(n.key).last_notified_at = new Date(now).toISOString();
            return out.notices.map((n) => `${n.type}:${n.key}`);
        },
    };
}

test('a condition must hold for the debounce time before it alerts', () => {
    const h = harness();
    assert.deepEqual(h.step(T0, [cond('server:2')]), []);
    assert.deepEqual(h.step(T0 + 30_000, [cond('server:2')]), []);
    assert.deepEqual(h.step(T0 + MIN, [cond('server:2')]), ['new:server:2']);
    assert.equal(h.rows.get('server:2').first_seen_at, new Date(T0).toISOString());
});

test('a blip shorter than the debounce never alerts', () => {
    const h = harness();
    h.step(T0, [cond('server:2')]);
    assert.deepEqual(h.step(T0 + 30_000, []), []);
    assert.deepEqual(h.step(T0 + MIN, [cond('server:2')]), [], 'the debounce restarts');
    assert.equal(h.rows.size, 0);
});

test('once, then a reminder per interval, then once resolved', () => {
    const h = harness();
    h.step(T0, [cond('lag:1:2')]);
    assert.deepEqual(h.step(T0 + MIN, [cond('lag:1:2')]), ['new:lag:1:2']);
    for (let t = T0 + 2 * MIN; t < T0 + MIN + 4 * HOUR; t += 30 * MIN) assert.deepEqual(h.step(t, [cond('lag:1:2')]), []);
    assert.deepEqual(h.step(T0 + MIN + 4 * HOUR, [cond('lag:1:2')]), ['reminder:lag:1:2']);
    assert.deepEqual(h.step(T0 + 2 * MIN + 4 * HOUR, [cond('lag:1:2')]), []);
    const gone = T0 + 5 * HOUR;
    assert.deepEqual(h.step(gone, []), [], 'resolve waits for the debounce');
    assert.deepEqual(h.step(gone + MIN, []), ['resolved:lag:1:2']);
    assert.equal(h.rows.get('lag:1:2').status, 'resolved');
    assert.deepEqual(h.step(gone + 2 * MIN, []), [], 'resolved is sent once');
});

test('a restart (fresh memo) re-sends nothing that is already active and notified', () => {
    const h = harness();
    h.step(T0, [cond('server:2')]);
    h.step(T0 + MIN, [cond('server:2')]);
    const restarted = { rows: h.rows, memo: createMemo() };
    const out = decide({ conditions: new Map([['server:2', cond('server:2')]]), rows: new Map(restarted.rows), memo: restarted.memo, now: T0 + 10 * MIN, ...opts });
    assert.deepEqual(out.notices, []);
    assert.deepEqual(out.writes, []);
});

test('a restart does not resolve an alert whose condition has not been re-detected yet', () => {
    const h = harness();
    h.step(T0, [cond('restore:1:2')]);
    h.step(T0 + MIN, [cond('restore:1:2')]);
    const memo = createMemo();
    const out = decide({ conditions: new Map(), rows: new Map(h.rows), memo, now: T0 + 10 * MIN, ...opts });
    assert.deepEqual(out.writes, [], 'first tick after the restart only starts the resolve debounce');
});

test('undelivered notices are retried until they get through', () => {
    const h = harness();
    h.step(T0, [cond('server:2')]);
    assert.deepEqual(h.step(T0 + MIN, [cond('server:2')], { delivered: false }), ['new:server:2']);
    assert.deepEqual(h.step(T0 + 2 * MIN, [cond('server:2')], { delivered: false }), ['new:server:2']);
    assert.deepEqual(h.step(T0 + 3 * MIN, [cond('server:2')]), ['new:server:2']);
    assert.deepEqual(h.step(T0 + 4 * MIN, [cond('server:2')]), []);
    h.step(T0 + 5 * MIN, []);
    assert.deepEqual(h.step(T0 + 6 * MIN, [], { delivered: false }), ['resolved:server:2']);
    assert.deepEqual(h.step(T0 + 7 * MIN, [], { delivered: false }), ['resolved:server:2'], 'pending resolved notice retried');
    assert.deepEqual(h.step(T0 + 8 * MIN, []), ['resolved:server:2']);
    assert.deepEqual(h.step(T0 + 9 * MIN, []), []);
});

test('an alert that was never delivered resolves silently', () => {
    const h = harness();
    h.step(T0, [cond('server:2')]);
    h.step(T0 + MIN, [cond('server:2')], { delivered: false });
    h.step(T0 + 2 * MIN, []);
    assert.deepEqual(h.step(T0 + 3 * MIN, [], { delivered: false }), []);
    assert.equal(h.rows.get('server:2').status, 'resolved');
});

test('a condition that comes back after resolving alerts again, with a new first-seen time', () => {
    const h = harness();
    h.step(T0, [cond('server:2')]);
    h.step(T0 + MIN, [cond('server:2')]);
    h.step(T0 + 2 * MIN, []);
    h.step(T0 + 3 * MIN, []);
    h.step(T0 + 10 * MIN, [cond('server:2')]);
    assert.deepEqual(h.step(T0 + 11 * MIN, [cond('server:2')]), ['new:server:2']);
    assert.equal(h.rows.get('server:2').first_seen_at, new Date(T0 + 10 * MIN).toISOString());
});

test('a changed message updates the row without a new notice', () => {
    const h = harness();
    h.step(T0, [cond('lag:1:2', 'Sales is 31 min behind')]);
    h.step(T0 + MIN, [cond('lag:1:2', 'Sales is 32 min behind')]);
    assert.deepEqual(h.step(T0 + 2 * MIN, [cond('lag:1:2', 'Sales is 33 min behind')]), []);
    assert.equal(h.rows.get('lag:1:2').message, 'Sales is 33 min behind');
});

test('reminders can be turned off', () => {
    const rows = new Map();
    const memo = createMemo();
    const run = (now) => decide({ conditions: new Map([['x:1', cond('x:1')]]), rows: new Map(rows), memo, now, ...opts, reminderMs: 0 });
    run(T0);
    const first = run(T0 + MIN);
    for (const w of first.writes) rows.set(w.key, { ...w, last_notified_at: new Date(T0 + MIN).toISOString() });
    assert.deepEqual(run(T0 + 100 * HOUR).notices, []);
});

test('per-condition confirm time overrides the default', () => {
    const h = harness();
    assert.deepEqual(h.step(T0, [{ ...cond('split:1:2'), confirmMs: 0 }]), ['new:split:1:2']);
});

test('one batched message: new errors first, quiet when only resolved', () => {
    const now = T0 + HOUR;
    const n = (type, key, severity, extra = {}) => ({ type, key, severity, message: `${key} message`, firstSeenAt: new Date(T0).toISOString(), resolvedAt: null, link: null, ...extra });
    const batch = formatBatch(
        [n('resolved', 'a', 'warn', { resolvedAt: new Date(T0 + 12 * MIN).toISOString() }), n('reminder', 'b', 'warn'), n('new', 'c', 'warn'), n('new', 'd', 'error')],
        { publicUrl: 'http://x', now },
    );
    assert.equal(batch.title, 'Mostly-On: 2 new, 1 still active, 1 resolved');
    assert.deepEqual(batch.message.split('\n'), ['ERROR: d message', 'WARNING: c message', 'STILL ACTIVE (1 h): b message', 'RESOLVED (after 12 min): a message']);
    assert.equal(batch.priority, 0);
    assert.equal(batch.url, 'http://x');

    const quiet = formatBatch([n('resolved', 'a', 'error', { resolvedAt: new Date(T0 + 90 * MIN).toISOString(), link: 'http://x/#/databases/1' })], { publicUrl: 'http://x', now });
    assert.equal(quiet.title, 'Mostly-On: resolved');
    assert.equal(quiet.priority, -1);
    assert.equal(quiet.url, 'http://x/#/databases/1');
    assert.equal(quiet.message, 'RESOLVED (after 1 h 30 min): a message');
});

test('a long batch is cut with a count of what was left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'new', key: `k${i}`, severity: 'error', message: `Database number ${i} is not ONLINE on its primary server somewhere`, firstSeenAt: new Date(T0).toISOString() }));
    const b = formatBatch(many, { publicUrl: 'http://x', now: T0 });
    assert.ok(b.message.length <= 1024, `message is ${b.message.length} chars`);
    assert.match(b.message, /… and \d+ more$/);
    assert.equal(b.title, 'Mostly-On: 40 new');
});

test('alerts a person clears (resolved operation, acknowledged backup) resolve without the debounce', () => {
    const rows = new Map();
    const memo = createMemo();
    const op = { ...cond('op:18'), kind: 'operation' };
    const run = (now, conditions) => {
        const out = decide({ conditions: new Map(conditions.map((c) => [c.key, c])), rows: new Map(rows), memo, now, ...opts, instantKinds: new Set(['operation']) });
        for (const w of out.writes) rows.set(w.key, { ...w, last_notified_at: new Date(now).toISOString() });
        return out.notices.map((n) => `${n.type}:${n.key}`);
    };
    run(T0, [op]);
    assert.deepEqual(run(T0 + MIN, [op]), ['new:op:18']);
    assert.deepEqual(run(T0 + MIN + 1000, []), ['resolved:op:18'], 'gone at the next evaluation');
});

test('an alert a check has just shown fixed (setup script in place) resolves without the debounce', () => {
    const rows = new Map();
    const memo = createMemo();
    const setup = { ...cond('setup:2'), kind: 'setup' };
    const run = (now, conditions, clearedKeys = new Set()) => {
        const out = decide({ conditions: new Map(conditions.map((c) => [c.key, c])), rows: new Map(rows), memo, now, ...opts, clearedKeys });
        for (const w of out.writes) rows.set(w.key, { ...w, last_notified_at: new Date(now).toISOString() });
        return out.notices.map((n) => `${n.type}:${n.key}`);
    };
    run(T0, [setup]);
    assert.deepEqual(run(T0 + MIN, [setup]), ['new:setup:2']);
    // Gone only because the server cannot be reached: the debounce still applies.
    assert.deepEqual(run(T0 + MIN + 1000, []), [], 'not resolved without a check that found it fixed');
    // The next check reaches the server and finds the script in place.
    assert.deepEqual(run(T0 + MIN + 2000, [], new Set(['setup:2'])), ['resolved:setup:2'], 'resolved at once');
});

test('backups-only databases: plain labels, a LOG taken elsewhere is a warning, and a failure of a type that no longer applies stays quiet', async () => {
    const crypto = await import('node:crypto');
    const { openDb, closeDb } = await import('../../src/store/db.js');
    const servers = await import('../../src/store/repos/servers.js');
    const databases = await import('../../src/store/repos/databases.js');
    const ops = await import('../../src/store/repos/operations.js');
    const foreign = await import('../../src/store/repos/foreign.js');
    const health = await import('../../src/engine/health.js');
    const { setEngineConfig } = await import('../../src/engine/context.js');
    const { collectConditions } = await import('../../src/notify/alerts.js');
    openDb(':memory:');
    setEngineConfig({ publicUrl: 'http://mo.test' });
    const s1 = servers.create(servers.validate({ name: 'sql1', host: 'sql1', username: 'u', password: 'p', sql_backup_root: '/b' }), crypto.randomBytes(32));
    const util = databases.manage({ name: 'Util', familyGuid: null, primaryServerId: s1.id, backupOnly: true });
    const live = (recoveryModel) => health._setForTests(s1.id, { ok: true, databases: [{ name: 'Util', databaseId: 9, state: 'ONLINE', recoveryModel, isInStandby: false }] });

    ops.create({ type: 'backup', databaseId: util.id, serverId: s1.id, params: { type: 'LOG' }, status: 'failed' });
    ops.create({ type: 'backup', databaseId: util.id, serverId: s1.id, params: { type: 'FULL' }, status: 'failed' });
    foreign.record({ uuid: 'u1', databaseId: util.id, serverId: s1.id, type: 'LOG', finishAt: null, device: '/x/u.trn' });
    foreign.record({ uuid: 'u2', databaseId: util.id, serverId: s1.id, type: 'FULL', finishAt: null, device: '/x/u.bak', acknowledged: true });

    live('FULL');
    let c = collectConditions();
    assert.match(c.get(`backup:${util.id}:FULL`).message, /^FULL backup of Util on sql1 failed/);
    assert.ok(c.has(`backup:${util.id}:LOG`), 'in FULL recovery a failed LOG counts');
    assert.equal(c.get('foreign:u1').severity, 'warn');
    assert.match(c.get('foreign:u1').message, /LOG backup of Util on sql1 was taken outside Mostly-On \(\/x\/u\.trn\)\. Restoring it past that point also needs that file/);
    assert.equal(c.has('foreign:u2'), false, 'a FULL taken elsewhere is only noted');

    live('SIMPLE');
    c = collectConditions();
    assert.equal(c.has(`backup:${util.id}:LOG`), false, 'LOG backups do not apply in SIMPLE recovery');
    assert.ok(c.has(`backup:${util.id}:FULL`));

    health._setForTests(s1.id, { ok: true, databases: [] });
    assert.match(collectConditions().get(`dbstate:${util.id}:${s1.id}`).message, /^Util on sql1 is missing, so it cannot be backed up/);
    health.forget(s1.id);
    closeDb();
});

test('a log-shipped database out of FULL recovery: an error in SIMPLE, a warning in BULK_LOGGED', async () => {
    const crypto = await import('node:crypto');
    const { openDb, closeDb } = await import('../../src/store/db.js');
    const servers = await import('../../src/store/repos/servers.js');
    const databases = await import('../../src/store/repos/databases.js');
    const health = await import('../../src/engine/health.js');
    const { tryAcquire } = await import('../../src/engine/locks.js');
    const { setEngineConfig } = await import('../../src/engine/context.js');
    const { collectConditions } = await import('../../src/notify/alerts.js');
    openDb(':memory:');
    setEngineConfig({ publicUrl: 'http://mo.test' });
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), crypto.randomBytes(32));
    const s1 = mk('sql1');
    const s2 = mk('sql2');
    const shop = databases.manage({ name: 'Shop', familyGuid: null, primaryServerId: s1.id });
    const util = databases.manage({ name: 'Util', familyGuid: null, primaryServerId: s1.id, backupOnly: true });
    const live = (recoveryModel) =>
        health._setForTests(s1.id, {
            ok: true,
            databases: ['Shop', 'Util'].map((name, i) => ({ name, databaseId: 9 + i, state: 'ONLINE', recoveryModel, isInStandby: false })),
        });
    const key = `recovery:${shop.id}`;

    live('FULL');
    assert.equal(collectConditions().has(key), false);

    live('SIMPLE');
    let c = collectConditions().get(key);
    assert.equal(c.severity, 'error');
    assert.equal(
        c.message,
        'Shop is in SIMPLE recovery on its primary sql1, so its log cannot be backed up and its log chain is broken. Switch it back to FULL recovery; Mostly-On then starts a new log chain with a full backup.',
    );
    assert.equal(collectConditions().has(`recovery:${util.id}`), false, 'a backups-only database only takes FULL backups in SIMPLE recovery: nothing to alert about');

    databases.addSecondary({ databaseId: shop.id, serverId: s2.id, restoreMode: 'norecovery' });
    assert.match(collectConditions().get(key).message, /Switch it back to FULL recovery, then reinitialize its secondaries\.$/);

    live('BULK_LOGGED');
    c = collectConditions().get(key);
    assert.equal(c.severity, 'warn');
    assert.equal(
        c.message,
        'Shop is in BULK_LOGGED recovery on its primary sql1, so Mostly-On takes no log backups of it and its secondaries fall behind. Switch it back to FULL recovery; shipping then catches up by itself.',
    );

    const release = tryAcquire(shop.id, 'exclusive');
    assert.equal(collectConditions().has(key), false, 'not while a failover or reseed holds the database');
    release();

    health._setForTests(s1.id, { ok: false, error: 'down' });
    assert.equal(collectConditions().has(key), false, 'an unreachable primary is reported as such instead');
    health.forget(s1.id);
    closeDb();
});

test('restore and lag alerts on a server whose setup script is out of date are left to the setup alert', async () => {
    const crypto = await import('node:crypto');
    const { openDb, closeDb } = await import('../../src/store/db.js');
    const servers = await import('../../src/store/repos/servers.js');
    const databases = await import('../../src/store/repos/databases.js');
    const backups = await import('../../src/store/repos/backups.js');
    const restores = await import('../../src/store/repos/restores.js');
    const health = await import('../../src/engine/health.js');
    const { setEngineConfig } = await import('../../src/engine/context.js');
    const { collectConditions, confirmedFixed } = await import('../../src/notify/alerts.js');
    openDb(':memory:');
    setEngineConfig({ publicUrl: 'http://mo.test' });
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), crypto.randomBytes(32));
    const s1 = mk('sql1');
    const s3 = mk('sql3');
    const big = databases.manage({ name: 'Big', familyGuid: null, primaryServerId: s1.id });
    databases.addSecondary({ databaseId: big.id, serverId: s3.id, restoreMode: 'norecovery' });
    databases.updateReplica(big.id, s3.id, { chain_state: 'ok' });
    const file = backups.insert({
        database_id: big.id, server_id: s1.id, type: 'LOG', rel_path: 'Big/LOG/1.trn', first_lsn: '1', last_lsn: '2', checkpoint_lsn: '1',
        database_backup_lsn: '1', family_guid: 'f', recovery_fork_guid: 'r', first_recovery_fork_guid: 'r', backup_set_uuid: 'b1',
        backup_start: '2026-11-26T10:00:00Z', backup_finish: '2026-11-26T10:00:01Z', size_bytes: 1, has_checksum: 1, is_copy_only: 0,
    });
    const r = restores.start({ backupFileId: file.id, databaseId: big.id, serverId: s3.id });
    restores.finish(r, 'failed', 'Mostly-On cannot back up or restore on sql3: the helper procedures are version 6');

    const dbs = [{ name: 'Big', databaseId: 9, state: 'RESTORING', recoveryModel: 'FULL', isInStandby: false }];
    health._setForTests(s1.id, { ok: true, databases: [{ ...dbs[0], state: 'ONLINE' }], setup: { ready: true, problems: [] } });
    health._setForTests(s3.id, { ok: true, databases: dbs, setup: { ready: false, problems: ['the helper procedures are version 6.'] } });
    let c = collectConditions();
    assert.ok(c.has(`setup:${s3.id}`));
    assert.equal(c.has(`restore:${big.id}:${s3.id}`), false, 'one cause, one alert');

    health._setForTests(s3.id, { ok: true, databases: dbs, setup: { ready: true, problems: [] } });
    c = collectConditions();
    assert.equal(c.has(`setup:${s3.id}`), false);
    assert.ok(confirmedFixed().has(`setup:${s3.id}`));
    assert.ok(c.has(`restore:${big.id}:${s3.id}`), 'once the setup is fixed, a failed restore counts again until one succeeds');
    health.forget(s1.id);
    health.forget(s3.id);
    closeDb();
});
