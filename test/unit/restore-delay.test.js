// A secondary kept deliberately behind (restore delay), and its pause: when a
// log may be restored, and that a delayed copy can never become the primary.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import * as ops from '../../src/store/repos/operations.js';
import { logDueAt, isPaused } from '../../src/engine/restore-plan.js';
import { restoreDelayProblem, restoreDelayChangeBlocker, delayText } from '../../src/engine/ops/shared.js';
import { failoverPreview, startForcedFailover, startPlannedFailover } from '../../src/engine/ops/failover.js';
import { switchoverTargets, switchoverPlan } from '../../src/engine/ops/switchover-all.js';
import { tryAcquire, acquire, _reset } from '../../src/engine/locks.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
beforeEach(() => _reset());

const MIN = 60_000;
const finish = '2026-11-22T10:00:00.000Z';
const at = (iso) => Date.parse(iso);

test('a log is due once it is as old as the delay; without a delay at once', () => {
    const log = { backup_finish: finish, created_at: '2026-11-22T10:00:05.000Z' };
    assert.equal(logDueAt(log, 0), 0);
    assert.equal(logDueAt(log, 720), at(finish) + 720 * MIN, '12 h after the backup finished');
    // A row without the finish time falls back to when it was recorded (never earlier).
    assert.equal(logDueAt({ ...log, backup_finish: null }, 60), at('2026-11-22T10:00:05.000Z') + 60 * MIN);
    // No time at all: due now, so a delayed copy never stalls for good.
    assert.equal(logDueAt({ backup_finish: null, created_at: null }, 60), 0);
    assert.equal(logDueAt({ backup_finish: 'garbage' }, 60), 0);
});

test('paused only while the pause lies in the future', () => {
    const now = at(finish);
    assert.equal(isPaused({ restores_paused_until: null }, now), false);
    assert.equal(isPaused({ restores_paused_until: '2026-11-22T11:00:00.000Z' }, now), true);
    assert.equal(isPaused({ restores_paused_until: '2026-11-22T09:00:00.000Z' }, now), false, 'a past value means catching up, not paused');
});

test('delays in words', () => {
    assert.equal(delayText(45), '45 min');
    assert.equal(delayText(720), '12 h');
    assert.equal(delayText(90), '1 h 30 min');
});

function setup() {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const [s1, s2, s3] = ['sql1', 'sql2', 'sql3'].map(mk);
    const db = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: s1.id });
    for (const s of [s2, s3]) {
        databases.addSecondary({ databaseId: db.id, serverId: s.id, restoreMode: 'norecovery' });
        databases.updateReplica(db.id, s.id, { chain_state: 'ok' });
    }
    // sql3 is kept 12 h behind, and paused.
    databases.updateReplica(db.id, s3.id, { restore_delay_minutes: 720, restores_paused_until: '2099-01-01T00:00:00.000Z' });
    return { s1, s2, s3, db };
}

test('the catalog keeps the delay through a reseed, but never on a primary', () => {
    const { s1, s2, s3, db } = setup();
    assert.equal(databases.replica(db.id, s3.id).restore_delay_minutes, 720);
    assert.equal(databases.replica(db.id, s2.id).restore_delay_minutes, 0, 'not delayed by default');
    // Reinitialize: the delay stays, the pause ends.
    databases.addSecondary({ databaseId: db.id, serverId: s3.id, restoreMode: 'norecovery' });
    assert.equal(databases.replica(db.id, s3.id).restore_delay_minutes, 720);
    assert.equal(databases.replica(db.id, s3.id).restores_paused_until, null);
    // A role swap clears delay and pause on both sides (here forced through the repository).
    databases.updateReplica(db.id, s3.id, { restores_paused_until: '2099-01-01T00:00:00.000Z' });
    databases.swapPrimary(db.id, { newPrimaryId: s3.id, oldPrimaryId: s1.id, oldPrimaryRole: 'secondary' });
    for (const s of [s1, s3]) {
        assert.equal(databases.replica(db.id, s.id).restore_delay_minutes, 0);
        assert.equal(databases.replica(db.id, s.id).restores_paused_until, null);
    }
    closeDb();
});

test('a readable copy\'s undo file is forgotten when it starts over (reinitialize, role swap)', () => {
    const { s1, s2, db } = setup();
    const undo = { standby_undo_file: '/var/opt/mssql/data/Sales.20261101T000000Z.tuf' };
    databases.updateReplica(db.id, s2.id, undo);
    assert.equal(databases.replica(db.id, s2.id).standby_undo_file, undo.standby_undo_file);
    databases.addSecondary({ databaseId: db.id, serverId: s2.id, restoreMode: 'standby' });
    assert.equal(databases.replica(db.id, s2.id).standby_undo_file, null, 'reinitialized: it starts a new undo file');
    databases.updateReplica(db.id, s2.id, undo);
    databases.swapPrimary(db.id, { newPrimaryId: s2.id, oldPrimaryId: s1.id, oldPrimaryRole: 'secondary' });
    assert.equal(databases.replica(db.id, s2.id).standby_undo_file, null);
    closeDb();
});

test('a delayed secondary is never a failover target', async () => {
    const { s2, s3, db } = setup();
    assert.match(restoreDelayProblem(databases.replica(db.id, s3.id)), /sql3 is kept 12 h behind on purpose \(restore delay\), so it can never take over/);
    assert.equal(restoreDelayProblem(databases.replica(db.id, s2.id)), null);
    assert.equal(restoreDelayProblem(databases.primaryOf(db.id)), null);
    // Every way in refuses before anything is touched: preview, planned, forced.
    const refused = (err) => err.status === 409 && /restore delay/.test(err.message);
    await assert.rejects(failoverPreview(db.id, s3.id), refused);
    await assert.rejects(startPlannedFailover(db.id, { serverId: s3.id }), refused);
    await assert.rejects(startForcedFailover(db.id, { serverId: s3.id, acceptDataLoss: true }), refused);
    closeDb();
});

test('"Fail over databases" never counts or picks a delayed copy', () => {
    const { s1, s3 } = setup();
    assert.deepEqual(switchoverTargets(s1.id).targets.map((t) => t.name), ['sql2'], 'sql3 only holds a delayed copy');
    const [item] = switchoverPlan(s1.id, s3.id).items;
    assert.equal(item.moves, false);
    assert.match(item.problem, /kept behind on purpose \(restore delay\)/);
    closeDb();
});

test('a delay cannot be set while a failover is running, waiting, or could still be resumed', async () => {
    const { s1, s2, db } = setup();
    const rep = () => databases.replica(db.id, s2.id);
    assert.equal(restoreDelayChangeBlocker(db, rep()), null);

    // Waiting for the exclusive lock (a backup holds a shared one), then holding it.
    const releaseLog = tryAcquire(db.id, 'log');
    const waiting = acquire(db.id, 'exclusive', { timeoutMs: 5000 });
    assert.match(restoreDelayChangeBlocker(db, rep()), /is running/);
    releaseLog();
    const releaseExclusive = await waiting;
    assert.match(restoreDelayChangeBlocker(db, rep()), /is running/);
    releaseExclusive();
    assert.equal(restoreDelayChangeBlocker(db, rep()), null);

    // A failed failover to this server could be resumed: blocked until it is resolved.
    const op = ops.create({ type: 'planned_failover', databaseId: db.id, serverId: s2.id, status: 'failed', steps: [] });
    assert.match(restoreDelayChangeBlocker(db, rep()), new RegExp(`Failover #${op.id} to sql2 has not finished`));
    ops.save(op.id, { status: 'resolved' });
    assert.equal(restoreDelayChangeBlocker(db, rep()), null);
    // A failover to another server does not matter.
    ops.create({ type: 'forced_failover', databaseId: db.id, serverId: s1.id, status: 'failed', steps: [] });
    assert.equal(restoreDelayChangeBlocker(db, rep()), null);
    closeDb();
});
