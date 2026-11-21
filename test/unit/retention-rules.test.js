// Retention consistency: FULL backups are never kept shorter than the DIFF and
// LOG backups that build on them (src/engine/retention-rules.js), globally,
// per database, and as a safety net when retention runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRetention, checkAllRetention, effectiveRetention, globalRetention, safeRetention } from '../../src/engine/retention-rules.js';
import { retentionPlan } from '../../src/engine/chain.js';
import { retentionProblem } from '../../public/views/retention.js';

test('FULL must be kept at least as long as DIFF and LOG; DIFF versus LOG is free', () => {
    assert.equal(checkRetention({ full: 28, diff: 14, log: 7 }), null);
    assert.equal(checkRetention({ full: 7, diff: 7, log: 7 }), null);
    assert.equal(checkRetention({ full: 28, diff: 3, log: 14 }), null, 'logs may reach further back than DIFFs');
    assert.match(checkRetention({ full: 7, diff: 7, log: 14 }), /at least as long as LOG backups \(14 days\)/);
    assert.match(checkRetention({ full: 7, diff: 10, log: 3 }), /at least as long as DIFF backups \(10 days\)/);
});

test('the dashboard uses the same rule as the server', () => {
    for (const r of [{ full: 28, diff: 14, log: 7 }, { full: 7, diff: 7, log: 14 }, { full: 7, diff: 10, log: 3 }, { full: 5, diff: 9, log: 9 }]) {
        assert.equal(retentionProblem(r), checkRetention(r), JSON.stringify(r));
    }
});

test("a database's own values override the global ones, field by field", () => {
    const g = globalRetention({ 'retention.full_days': 28, 'retention.diff_days': 14, 'retention.log_days': 7 });
    assert.deepEqual(effectiveRetention({ retention_full_days: null, retention_diff_days: null, retention_log_days: 21 }, g), { full: 28, diff: 14, log: 21 });
    assert.deepEqual(effectiveRetention({}, g), g);
});

test('a global change that breaks one database is refused, naming that database', () => {
    const dbs = [
        { name: 'Big', retention_full_days: null, retention_diff_days: null, retention_log_days: null },
        { name: 'Sales', retention_full_days: null, retention_diff_days: null, retention_log_days: 14 },
    ];
    assert.equal(checkAllRetention({ full: 28, diff: 14, log: 7 }, dbs), null);
    assert.match(checkAllRetention({ full: 10, diff: 7, log: 7 }, dbs), /^Sales: FULL backups must be kept at least as long as LOG backups \(14 days\)/);
    assert.match(checkAllRetention({ full: 5, diff: 7, log: 7 }, dbs), /^FULL backups/, 'a problem with the global values themselves comes first');
});

test('safety net: retention never deletes a FULL that kept DIFF or LOG backups need', () => {
    assert.deepEqual(safeRetention({ full: 3, diff: 5, log: 10 }), { full: 10, diff: 5, log: 10 });

    const day = (n) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();
    const now = new Date(Date.UTC(2026, 10, 30));
    const f = (id, type, first, last, finishDay) => ({ id, type, first_lsn: String(first), last_lsn: String(last), checkpoint_lsn: String(first), backup_set_uuid: `u${id}`, differential_base_guid: null, backup_finish: day(finishDay), file_status: 'present' });
    // An older FULL (day 20) with logs after it, and the newest FULL (day 27) with its logs.
    const files = [f(1, 'FULL', 100, 110, 20), f(2, 'LOG', 100, 200, 21), f(3, 'LOG', 200, 300, 26), f(4, 'FULL', 300, 310, 27), f(5, 'LOG', 300, 400, 28)];
    const plan = (r) => retentionPlan({ files, secondaries: [], retentionDays: { FULL: r.full, DIFF: r.diff, LOG: r.log }, now }).deletable.map((x) => x.id);
    // Inconsistent settings would delete FULL #1 while keeping its logs #2 and #3:
    assert.deepEqual(plan({ full: 5, diff: 5, log: 14 }), [1]);
    // With the safety net, the FULL is kept as long as its logs.
    const safe = safeRetention({ full: 5, diff: 5, log: 14 });
    assert.deepEqual(plan(safe), []);
});
