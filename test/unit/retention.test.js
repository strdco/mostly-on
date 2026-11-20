import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retentionPlan, newestBase } from '../../src/engine/chain.js';

const day = (n) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();
const now = new Date(Date.UTC(2026, 10, 30));
const days = { FULL: 7, DIFF: 7, LOG: 3 };
let nextId = 1;
const f = (type, first, last, finishDay, extra = {}) => ({
    id: nextId++,
    type,
    first_lsn: String(first),
    last_lsn: String(last),
    checkpoint_lsn: String(first),
    backup_set_uuid: `uuid-${nextId}`,
    differential_base_guid: null,
    backup_finish: day(finishDay),
    file_status: 'present',
    ...extra,
});

function chain() {
    nextId = 1;
    const full1 = f('FULL', 100, 110, 0);
    const logs1 = [f('LOG', 100, 200, 1), f('LOG', 200, 300, 2)];
    const full2 = f('FULL', 300, 310, 10);
    const diff2 = f('DIFF', 400, 410, 15, { differential_base_guid: full2.backup_set_uuid });
    const logs2 = [f('LOG', 300, 400, 12), f('LOG', 400, 500, 16), f('LOG', 500, 600, 28)];
    return { full1, logs1, full2, diff2, logs2, files: [full1, ...logs1, full2, diff2, ...logs2] };
}

test('newest base is the newest full plus its newest diff', () => {
    const c = chain();
    const b = newestBase(c.files);
    assert.equal(b.full.id, c.full2.id);
    assert.equal(b.diff.id, c.diff2.id);
    assert.equal(b.position, '410');
});

test('old files outside the newest chain are deleted, the chain is kept', () => {
    const c = chain();
    const plan = retentionPlan({ files: c.files, secondaries: [], retentionDays: days, now });
    const deleted = plan.deletable.map((x) => x.id).sort((a, b) => a - b);
    // full1 + its logs + the log between full2 and diff2 are old and not needed
    assert.deepEqual(deleted, [c.full1.id, ...c.logs1.map((x) => x.id), c.logs2[0].id].sort((a, b) => a - b));
    assert.ok(plan.protectedIds.has(c.full2.id));
    assert.ok(plan.protectedIds.has(c.diff2.id));
    assert.ok(plan.protectedIds.has(c.logs2[1].id), 'log after the diff is protected even though it is old');
});

test('logs a secondary still needs are never deleted', () => {
    const c = chain();
    const plan = retentionPlan({
        files: c.files,
        secondaries: [{ server_id: 2, role: 'secondary', position_lsn: '150' }],
        retentionDays: days,
        now,
    });
    const deleted = new Set(plan.deletable.map((x) => x.id));
    for (const l of [...c.logs1, ...c.logs2]) assert.ok(!deleted.has(l.id), `log ${l.id} must be kept`);
    assert.ok(deleted.has(c.full1.id), 'old full itself is not needed by a log-restoring secondary');
});

test('a secondary without a known position blocks all deletion', () => {
    const c = chain();
    const plan = retentionPlan({ files: c.files, secondaries: [{ server_id: 2, role: 'secondary', position_lsn: null }], retentionDays: days, now });
    assert.equal(plan.deletable.length, 0);
    assert.match(plan.blocked, /no known restore position/);
});

test('diverged replicas do not protect anything; diverged safety backups are never deleted', () => {
    const c = chain();
    const safety = f('DIVERGED', 1, 2, 0);
    const plan = retentionPlan({
        files: [...c.files, safety],
        secondaries: [{ server_id: 3, role: 'diverged', position_lsn: null }],
        retentionDays: days,
        now,
    });
    assert.equal(plan.blocked, null);
    assert.ok(!plan.deletable.some((x) => x.id === safety.id));
});

test('no full on disk means nothing is deleted', () => {
    const c = chain();
    const files = c.files.filter((x) => x.type !== 'FULL');
    const plan = retentionPlan({ files, secondaries: [], retentionDays: days, now });
    assert.equal(plan.deletable.length, 0);
});

test('files in use by running operations are protected', () => {
    const c = chain();
    const plan = retentionPlan({ files: c.files, secondaries: [], retentionDays: days, now, extraProtected: new Set([c.full1.id]) });
    assert.ok(!plan.deletable.some((x) => x.id === c.full1.id));
});

test('LSN comparison beyond 2^53 in retention', () => {
    nextId = 1;
    const full = f('FULL', '44000000026400001', '44000000028800001', 0);
    const oldLog = f('LOG', '44000000026400001', '44000000028800001', 0);
    const newLog = f('LOG', '44000000028800001', '44000000028800002', 0);
    const plan = retentionPlan({ files: [full, oldLog, newLog], secondaries: [], retentionDays: days, now });
    assert.ok(plan.protectedIds.has(newLog.id), 'last_lsn one above the base position must be protected');
    assert.ok(plan.deletable.some((x) => x.id === oldLog.id));
});
