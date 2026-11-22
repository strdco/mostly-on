// A failover or rollback resumed after the roles changed must stop at its lock
// step instead of acting on an old picture of the servers
// (assertStillApplies in src/engine/ops/shared.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import * as ops from '../../src/store/repos/operations.js';
import { assertStillApplies } from '../../src/engine/ops/shared.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');

function setup() {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const [s1, s2, s3] = ['sql1', 'sql2', 'sql3'].map(mk);
    const db = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: s1.id });
    for (const s of [s2, s3]) databases.addSecondary({ databaseId: db.id, serverId: s.id, restoreMode: 'norecovery' });
    return { s1, s2, s3, db };
}

const steps = (statuses) => Object.entries(statuses).map(([name, status]) => ({ name, label: name, status }));
const failover = (db, s, statuses) => ops.create({ type: 'planned_failover', databaseId: db.id, serverId: s.id, status: 'failed', steps: steps(statuses) });

test('an operation nothing has overtaken may continue', () => {
    const { s1, s2, db } = setup();
    const op = failover(db, s2, { lock: 'done', validate: 'done', catch_up: 'done', tail_log: 'failed', recover: 'pending' });
    assert.doesNotThrow(() => assertStillApplies(db, op, [s1.id, s2.id]));
    // A later failover that stopped at its checks changed nothing.
    failover(db, s2, { lock: 'done', validate: 'failed', catch_up: 'pending' });
    assert.doesNotThrow(() => assertStillApplies(db, op, [s1.id, s2.id]));
    // Seeds and copies never change the roles.
    ops.create({ type: 'reseed', databaseId: db.id, steps: steps({ lock: 'done', restore: 'done' }) });
    assert.doesNotThrow(() => assertStillApplies(db, op, [s1.id, s2.id]));
});

test('a later failover that got past its checks stops a resumed one, whatever the roles say now', () => {
    const { s1, s2, s3, db } = setup();
    const op = failover(db, s2, { lock: 'done', validate: 'done', catch_up: 'done', tail_log: 'done', restore_tail: 'done', recover: 'failed' });
    // sql1 -> sql3 and back again: sql1 is the primary once more, but history moved on twice.
    failover(db, s3, { lock: 'done', validate: 'done', catch_up: 'done', tail_log: 'done', swap_roles: 'done' });
    assert.throws(() => assertStillApplies(db, op, [s1.id, s2.id]), /roles of Sales changed: operation #2 \(planned failover\)/);
});

test('a primary other than the expected ones stops it', () => {
    const { s1, s2, s3, db } = setup();
    const op = ops.create({ type: 'pitr_rollback', databaseId: db.id, serverId: s1.id, status: 'failed', steps: steps({ lock: 'done', validate: 'failed' }) });
    assert.doesNotThrow(() => assertStillApplies(db, op, [s1.id]));
    databases.swapPrimary(db.id, { newPrimaryId: s3.id, oldPrimaryId: s1.id, oldPrimaryRole: 'secondary', oldPrimaryPatch: {} });
    assert.throws(() => assertStillApplies(db, op, [s1.id]), /sql3 is its primary now/);
    assert.throws(() => assertStillApplies(db, op, [s1.id, s2.id]), /sql3 is its primary now/);
});
