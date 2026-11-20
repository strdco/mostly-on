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
