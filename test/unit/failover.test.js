import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { onLineage, lineageProblem, nextLog, reachable, lag, newestBaseOnLineage, retentionPlan } from '../../src/engine/chain.js';
import { tryAcquire, acquire, _reset } from '../../src/engine/locks.js';
import { classifyRestoreError } from '../../src/engine/restore-plan.js';

// Mirrors what SQL Server did in the probe runs (smaller LSNs):
//   F0 root
//   planned failover: tail ends at 300, the new primary recovers -> F1 at fork point 300
//   forced failover:  target recovered at 500 (L4 never reached it) -> F2 at fork point 500
let id = 0;
const log = (name, first, last, firstFork, lastFork = firstFork, extra = {}) => ({
    id: ++id,
    type: 'LOG',
    rel_path: `Sales/LOG/${name}.trn`,
    first_lsn: String(first),
    last_lsn: String(last),
    first_recovery_fork_guid: firstFork,
    recovery_fork_guid: lastFork,
    backup_finish: `2026-11-20T10:${String(id).padStart(2, '0')}:00.000Z`,
    file_status: 'present',
    ...extra,
});
const full = { id: 1000, type: 'FULL', rel_path: 'Sales/FULL/f.bak', first_lsn: '100', last_lsn: '150', first_recovery_fork_guid: 'F0', recovery_fork_guid: 'F0', backup_set_uuid: 'full-1', backup_finish: '2026-11-20T09:00:00.000Z', file_status: 'present' };
const L1 = log('L1', 100, 200, 'F0');
const tail = log('tail', 200, 300, 'F0', 'F0', { is_tail: 1 });
const L2 = log('L2', 300, 400, 'F0', 'F1'); // first log on the new primary: crosses F0 -> F1
const L3 = log('L3', 400, 500, 'F1');
const L4 = log('L4', 500, 600, 'F1'); // written by the old primary, never reached the forced-failover target
const L5 = log('L5', 500, 700, 'F1', 'F2'); // first log after the forced failover
const files = [full, L1, tail, L2, L3, L4, L5];
const lineage = [
    { fork_guid: 'F0', fork_point_lsn: null },
    { fork_guid: 'F1', fork_point_lsn: '300' },
    { fork_guid: 'F2', fork_point_lsn: '500' },
];

test('files on the active lineage', () => {
    assert.equal(onLineage(tail, lineage), true, 'the tail ends exactly at the fork point');
    assert.equal(onLineage(L2, lineage), true, 'a log crossing F0 -> F1');
    assert.equal(onLineage(L3, lineage), true);
    assert.equal(onLineage(L4, lineage), false, 'F1 log past the F2 fork point was abandoned');
    assert.equal(onLineage(L5, lineage), true);
    assert.equal(onLineage(log('x', 300, 350, 'F0', 'F2'), lineage), false, 'crossing into F2 from anything but F1 is not on the path');
    assert.equal(onLineage(log('y', 1, 2, 'FX'), lineage), false, 'unknown fork');
    assert.equal(onLineage(L4, null), true, 'no lineage recorded: everything counts');
});

test('the old primary after a planned failover continues across the fork', () => {
    const r = nextLog({ files, position: '300', forkGuid: 'F0', lineage });
    assert.equal(r.file.id, L2.id);
    assert.equal(lineageProblem({ position: '300', forkGuid: 'F0', lineage }), null);
});

test('at the forced-failover fork point the abandoned log is skipped', () => {
    const r = nextLog({ files, position: '500', forkGuid: 'F1', lineage });
    assert.equal(r.file.id, L5.id);
    assert.equal(nextLog({ files, position: '700', forkGuid: 'F2', lineage }).status, 'caught_up');
});

test('a secondary that restored past a fork point needs a reseed', () => {
    assert.match(lineageProblem({ position: '600', forkGuid: 'F1', lineage }), /(LSN 500)/);
    assert.match(lineageProblem({ position: '450', forkGuid: 'FX', lineage }), /not on the current primary's recovery path/);
    assert.equal(lineageProblem({ position: '450', forkGuid: 'F1', lineage }), null, 'behind the fork point: it can follow');
    assert.equal(lineageProblem({ position: '650', forkGuid: 'F2', lineage }), null, 'on the newest fork');
});

test('reachable() walks the whole path and counts the logs', () => {
    const r = reachable({ files, position: '150', forkGuid: 'F0', lineage });
    assert.equal(r.position, '700');
    assert.equal(r.files, 5); // L1, tail, L2, L3, L5
    assert.equal(r.lastFile.id, L5.id);
    assert.equal(r.gap, null);
    const gapped = reachable({ files: files.filter((f) => f !== L3), position: '150', forkGuid: 'F0', lineage });
    assert.equal(gapped.position, '400');
    assert.match(gapped.gap, /stopped at LSN 400/);
});

test('lag ignores abandoned logs', () => {
    assert.equal(lag({ files, position: '500', lineage }).files, 1, 'only L5, not L4');
    assert.equal(lag({ files, position: '500' }).files, 2, 'without a lineage both count');
});

test('a FULL taken past the fork point is not a seed or retention base', () => {
    const abandonedFull = { ...full, id: 2000, first_lsn: '520', last_lsn: '560', recovery_fork_guid: 'F1', first_recovery_fork_guid: 'F1', backup_set_uuid: 'full-2', backup_finish: '2026-11-20T11:00:00.000Z' };
    const all = [...files, abandonedFull];
    assert.equal(newestBaseOnLineage(all, lineage).full.id, full.id);
    const plan = retentionPlan({ files: all, secondaries: [], retentionDays: { FULL: 0, DIFF: 0, LOG: 0 }, now: new Date('2027-01-01'), lineage });
    assert.ok(plan.protectedIds.has(full.id), 'the real base stays protected');
    assert.ok(!plan.protectedIds.has(abandonedFull.id));
});

test('error 4330 (other recovery path) is classified', () => {
    assert.equal(classifyRestoreError({ number: 3013, precedingErrors: [{ number: 4330 }] }), 'wrong_fork');
});

beforeEach(() => _reset());

test('a waiting exclusive lock blocks new shared locks (no starvation)', async () => {
    const restore = tryAcquire(1, 'restore:2');
    const pending = acquire(1, 'exclusive', { timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tryAcquire(1, 'restore:3'), null, 'new restore streams wait behind the failover');
    assert.equal(tryAcquire(1, 'log'), null);
    assert.ok(tryAcquire(2, 'log'), 'other databases are not affected');
    restore();
    const ex = await pending;
    assert.equal(tryAcquire(1, 'log'), null);
    ex();
    assert.ok(tryAcquire(1, 'log'), 'free again after release');
});
