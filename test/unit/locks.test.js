import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tryAcquire, acquire, conflicts, _reset, BusyError } from '../../src/engine/locks.js';

beforeEach(() => _reset());

test('conflict matrix', () => {
    assert.equal(conflicts('full', 'diff'), true);
    assert.equal(conflicts('full', 'full'), true);
    assert.equal(conflicts('full', 'log'), false);
    assert.equal(conflicts('log', 'log'), true);
    assert.equal(conflicts('log', 'restore:2'), false);
    assert.equal(conflicts('restore:2', 'restore:2'), true);
    assert.equal(conflicts('restore:2', 'restore:3'), false);
    assert.equal(conflicts('exclusive', 'log'), true);
    assert.equal(conflicts('retention', 'log'), false);
    assert.equal(conflicts('retention', 'exclusive'), true);
});

test('log may run during full; diff may not', () => {
    const full = tryAcquire(1, 'full');
    assert.ok(full);
    assert.ok(tryAcquire(1, 'log'));
    assert.equal(tryAcquire(1, 'diff'), null);
    assert.ok(tryAcquire(2, 'diff'), 'other databases are independent');
    full();
    full(); // double release is harmless
    assert.ok(tryAcquire(1, 'diff'));
});

test('exclusive waits and times out', async () => {
    const rel = tryAcquire(1, 'log');
    await assert.rejects(acquire(1, 'exclusive', { timeoutMs: 300 }), BusyError);
    setTimeout(rel, 100);
    const ex = await acquire(1, 'exclusive', { timeoutMs: 2000 });
    assert.equal(tryAcquire(1, 'log'), null);
    ex();
});
