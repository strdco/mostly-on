import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, validateSchedule } from '../../src/engine/schedule-math.js';

// These tests use local time; run with any TZ.
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);

test('interval schedules align to a fixed grid', () => {
    const s = { kind: 'interval', interval_minutes: 5 };
    const from = new Date(Date.UTC(2026, 10, 20, 10, 3, 17));
    assert.equal(nextRun(s, from).toISOString(), '2026-11-20T10:05:00.000Z');
    assert.equal(nextRun(s, new Date(Date.UTC(2026, 10, 20, 10, 5, 0))).toISOString(), '2026-11-20T10:10:00.000Z');
});

test('daily schedules run later today or tomorrow', () => {
    const s = { kind: 'daily', at_time: '01:30' };
    assert.deepEqual(nextRun(s, at(2026, 11, 20, 0, 10)), at(2026, 11, 20, 1, 30));
    assert.deepEqual(nextRun(s, at(2026, 11, 20, 1, 30)), at(2026, 11, 21, 1, 30));
    assert.deepEqual(nextRun(s, at(2026, 11, 20, 23, 0)), at(2026, 11, 21, 1, 30));
});

test('weekly schedules pick the next matching weekday', () => {
    const s = { kind: 'weekly', weekday: 0, at_time: '01:00' }; // Sunday
    // 2026-11-20 is a Friday
    assert.deepEqual(nextRun(s, at(2026, 11, 20, 12, 0)), at(2026, 11, 22, 1, 0));
    assert.deepEqual(nextRun(s, at(2026, 11, 22, 0, 59)), at(2026, 11, 22, 1, 0));
    assert.deepEqual(nextRun(s, at(2026, 11, 22, 1, 0)), at(2026, 11, 29, 1, 0));
});

test('schedule validation', () => {
    assert.deepEqual(validateSchedule({ kind: 'interval', interval_minutes: 15 }), { enabled: 1, kind: 'interval', interval_minutes: 15, at_time: null, weekday: null });
    assert.throws(() => validateSchedule({ kind: 'interval', interval_minutes: 0 }));
    assert.throws(() => validateSchedule({ kind: 'daily', at_time: '25:00' }));
    assert.throws(() => validateSchedule({ kind: 'weekly', at_time: '01:00', weekday: 7 }));
    assert.throws(() => validateSchedule({ kind: 'cron' }));
});

test('a scheduled backup that does not apply right now moves on quietly; a failure retries within a minute', async () => {
    const { afterStartError } = await import('../../src/engine/scheduler.js');
    const s = { kind: 'interval', interval_minutes: 15 };
    const now = new Date(Date.UTC(2026, 10, 20, 10, 1, 0));
    const skip = afterStartError(s, Object.assign(new Error('x'), { notApplicable: true, skipStatus: 'skipped: SIMPLE recovery' }), now);
    assert.deepEqual(skip, { failed: false, status: 'skipped: SIMPLE recovery', nextRunAt: new Date(Date.UTC(2026, 10, 20, 10, 15, 0)) });
    const fail = afterStartError(s, new Error('Primary sql1 is unreachable'), now);
    assert.equal(fail.failed, true);
    assert.equal(fail.status, 'failed: Primary sql1 is unreachable');
    assert.equal(fail.nextRunAt.toISOString(), '2026-11-20T10:02:00.000Z');
});

test('default schedules as stored: only the DIFF default can be off', async () => {
    const { defaultScheduleValue } = await import('../../src/http/routes/misc.js');
    const daily = { kind: 'daily', at_time: '01:30' };
    assert.deepEqual(defaultScheduleValue('schedule.default_diff', { ...daily, enabled: false }, {}), { kind: 'daily', interval_minutes: null, at_time: '01:30', weekday: null, enabled: false });
    assert.equal(defaultScheduleValue('schedule.default_diff', daily, { enabled: false }).enabled, false, 'left out: stays as it was');
    assert.equal(defaultScheduleValue('schedule.default_diff', daily, { kind: 'daily' }).enabled, true, 'stored before the switch existed: on');
    assert.equal('enabled' in defaultScheduleValue('schedule.default_log', { kind: 'interval', interval_minutes: 5, enabled: false }, {}), false, 'FULL and LOG are never optional');
    assert.throws(() => defaultScheduleValue('schedule.default_full', null, {}), /must be a schedule/);
});
