// The audit trail: who did what (events.actor, operations.created_by) and the
// copy of key actions for the SQL Server error log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../../src/store/db.js';
import * as events from '../../src/store/repos/events.js';
import * as ops from '../../src/store/repos/operations.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
before(() => openDb(':memory:'));
after(() => {
    events.setErrorLogWriter(null);
    closeDb();
});

test('events of an operation name the user who started it; child operations inherit it', () => {
    const op = ops.create({ type: 'switchover_all', createdBy: 'alice' });
    const child = ops.create({ type: 'planned_failover', parentId: op.id });
    assert.equal(ops.get(child.id).created_by, 'alice');
    assert.equal(events.add('info', 'failover', 'step done', { operationId: child.id }).actor, 'alice');
    assert.equal(events.add('warn', 'failover', 'resumed', { operationId: child.id, actor: 'bob' }).actor, 'bob', 'an explicit actor wins');
    const routine = ops.create({ type: 'backup' });
    assert.equal(events.add('info', 'backup', 'scheduled', { operationId: routine.id }).actor, null, 'Mostly-On itself');
});

test('peopleOnly lists only what users did', () => {
    events.add('info', 'restore', 'log restored');
    events.add('info', 'settings', 'Settings changed', { actor: 'carol' });
    const audit = events.list({ peopleOnly: true });
    assert.ok(audit.length >= 1);
    assert.ok(audit.every((e) => e.actor));
    assert.ok(events.list().some((e) => e.actor === null));
});

test('errorLog sends one line per distinct server, with who and which operation', () => {
    const sent = [];
    events.setErrorLogWriter((serverId, text) => sent.push([serverId, text]));
    const op = ops.create({ type: 'forced_failover', createdBy: 'dave' });
    events.add('warn', 'failover', 'Failover of db1 from A to B started', { operationId: op.id, errorLog: [1, 2, 2, null, undefined] });
    events.add('info', 'backup', 'not a key action', { serverId: 1 });
    assert.deepEqual(sent, [
        [1, `Failover of db1 from A to B started (by dave, operation #${op.id})`],
        [2, `Failover of db1 from A to B started (by dave, operation #${op.id})`],
    ]);
    assert.equal(events.errorLogText({ message: 'x', actor: null, operationId: null }), 'x (by Mostly-On)');
});
