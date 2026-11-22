// At most N backups and restores at a time per SQL Server (src/sql/slots.js):
// the rest wait in line, in order; work still waiting gives way to a failover.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as settings from '../../src/store/repos/settings.js';
import * as databases from '../../src/store/repos/databases.js';
import * as ops from '../../src/store/repos/operations.js';
import * as P from '../../src/sql/privileged.js';
import { acquireSlot, slotStatus, limitFor, _reset } from '../../src/sql/slots.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let s1;
let s2;

beforeEach(() => {
    _reset();
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name, extra = {}) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b', ...extra }), key);
    s1 = mk('sql1');
    s2 = mk('sql2', { max_parallel: 1 });
});
afterEach(() => {
    _reset();
    closeDb();
});

/** Starts n acquires; records the order in which they get a place. */
function contenders(serverId, n, opts = {}) {
    const order = [];
    const releases = {};
    const done = Array.from({ length: n }, (_, i) =>
        acquireSlot(serverId, opts).then((release) => {
            order.push(i);
            releases[i] = release;
        }),
    );
    return { order, releases, done };
}

test('two at a time by default; the rest wait their turn, first come first served', async () => {
    assert.equal(limitFor(s1.id), 2, 'the default for a new orchestrator');
    const c = contenders(s1.id, 4);
    await sleep(20);
    assert.deepEqual(c.order, [0, 1]);
    assert.deepEqual(slotStatus(s1.id), { limit: 2, running: 2, waiting: 2 });
    c.releases[1]();
    await sleep(20);
    assert.deepEqual(c.order, [0, 1, 2], 'the first in line goes next');
    c.releases[0]();
    c.releases[2]();
    await sleep(20);
    assert.deepEqual(c.order, [0, 1, 2, 3]);
    c.releases[3]();
    c.releases[3](); // releasing twice is harmless
    assert.deepEqual(slotStatus(s1.id), { limit: 2, running: 0, waiting: 0 });
});

test('a server can have its own limit, and a raised limit lets waiting work in', async () => {
    assert.equal(limitFor(s2.id), 1);
    const c = contenders(s2.id, 3);
    await sleep(20);
    assert.deepEqual(c.order, [0]);
    servers.update(s2.id, { max_parallel: 3 }, crypto.randomBytes(32));
    await sleep(700); // waiting work looks again every 500 ms
    assert.deepEqual(c.order, [0, 1, 2]);
    // Back to the orchestrator's default, which can change too.
    servers.update(s2.id, { max_parallel: null }, crypto.randomBytes(32));
    settings.set('servers.max_parallel', 5);
    assert.equal(limitFor(s2.id), 5);
});

test('work still waiting gives way when asked, and the line moves on', async () => {
    const first = await acquireSlot(s2.id);
    let giveWay = false;
    const waits = [];
    const waiting = acquireSlot(s2.id, { abortWhen: () => giveWay && 'a failover of Sales needed the database first', onWait: (s) => waits.push(s) });
    const after = contenders(s2.id, 1);
    await sleep(20);
    assert.deepEqual(waits, [{ running: 1, limit: 1, ahead: 0 }], 'told it waits, and its place');
    giveWay = true;
    await assert.rejects(waiting, (err) => err.gaveWay === true && /failover of Sales/.test(err.message));
    assert.equal(slotStatus(s2.id).waiting, 1, 'it left the line');
    first();
    await sleep(20);
    assert.deepEqual(after.order, [0], 'the next in line got the place');
    after.releases[0]();
});

test('only backups and restores count against the limit', () => {
    assert.equal(P.takeBackup({ db: 'x', type: 'LOG', path: '/b/x.trn', name: 'n', description: 'd' }).work, true);
    assert.equal(P.restoreDatabase({ db: 'x', path: '/b/f.bak' }).work, true);
    assert.equal(P.restoreLog({ db: 'x', path: '/b/l.trn' }).work, true);
    assert.equal(P.recover({ db: 'x' }).work, true);
    assert.equal(P.headerOnly({ path: '/b/f.bak' }).work, false, 'reading a file header is a short query');
    assert.equal(P.setState({ db: 'x', state: 'OFFLINE' }).work, false);
    assert.equal(P.purgeBackupHistory({ keepDays: 30 }).work, false);
});

test('the default and a server\'s own value are whole numbers from 1 to 10 (empty: the default)', () => {
    assert.throws(() => settings.set('servers.max_parallel', 0), /at least 1/);
    assert.throws(() => settings.set('servers.max_parallel', 11), /at most 10/);
    assert.throws(() => settings.set('servers.max_parallel', 2.5), /whole number/);
    const v = (max_parallel) => servers.validate({ max_parallel }, { partial: true }).max_parallel;
    assert.equal(v(''), null);
    assert.equal(v(null), null);
    assert.equal(v('4'), 4);
    assert.throws(() => v(0), /1 to 10/);
    assert.throws(() => v(11), /1 to 10/);
    assert.throws(() => v('two'), /1 to 10/);
});

test('a backup that gave way to a failover is not a failed backup to alert about', () => {
    const db = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: s1.id });
    ops.create({ type: 'backup', databaseId: db.id, params: { type: 'LOG' }, status: 'failed', ctx: { gaveWay: true }, steps: [] });
    assert.deepEqual(ops.failedBackups(), []);
    ops.create({ type: 'backup', databaseId: db.id, params: { type: 'FULL' }, status: 'failed', steps: [] });
    assert.deepEqual(ops.failedBackups().map((f) => f.backup_type), ['FULL'], 'a real failure still counts');
});
