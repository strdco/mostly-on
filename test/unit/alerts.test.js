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
    assert.equal(batch.title, 'Mostly On: 2 new, 1 still active, 1 resolved');
    assert.deepEqual(batch.message.split('\n'), ['ERROR: d message', 'WARNING: c message', 'STILL ACTIVE (1 h): b message', 'RESOLVED (after 12 min): a message']);
    assert.equal(batch.priority, 0);
    assert.equal(batch.url, 'http://x');

    const quiet = formatBatch([n('resolved', 'a', 'error', { resolvedAt: new Date(T0 + 90 * MIN).toISOString(), link: 'http://x/#/databases/1' })], { publicUrl: 'http://x', now });
    assert.equal(quiet.title, 'Mostly On: resolved');
    assert.equal(quiet.priority, -1);
    assert.equal(quiet.url, 'http://x/#/databases/1');
    assert.equal(quiet.message, 'RESOLVED (after 1 h 30 min): a message');
});

test('a long batch is cut with a count of what was left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'new', key: `k${i}`, severity: 'error', message: `Database number ${i} is not ONLINE on its primary server somewhere`, firstSeenAt: new Date(T0).toISOString() }));
    const b = formatBatch(many, { publicUrl: 'http://x', now: T0 });
    assert.ok(b.message.length <= 1024, `message is ${b.message.length} chars`);
    assert.match(b.message, /… and \d+ more$/);
    assert.equal(b.title, 'Mostly On: 40 new');
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
