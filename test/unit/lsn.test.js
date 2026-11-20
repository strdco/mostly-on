import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lsn from '../../src/lsn.js';

test('compares LSNs beyond 2^53 exactly', () => {
    // These two differ by 1 but are equal as JS numbers.
    const a = '39000000012345600001';
    const b = '39000000012345600002';
    assert.equal(Number(a), Number(b));
    assert.equal(lsn.cmp(a, b), -1);
    assert.equal(lsn.cmp(b, a), 1);
    assert.equal(lsn.cmp(a, a), 0);
    assert.ok(lsn.lt(a, b) && lsn.lte(a, a) && lsn.gt(b, a) && lsn.gte(b, b) && lsn.eq(a, '039000000012345600001'));
});

test('max/min ignore nulls', () => {
    assert.equal(lsn.max(null, '5', '17', undefined, '9'), '17');
    assert.equal(lsn.min('5', null, '17'), '5');
    assert.equal(lsn.max(), null);
});

test('rejects non-LSN input', () => {
    assert.throws(() => lsn.cmp('12a', '1'));
    assert.throws(() => lsn.cmp(12, '1'));
    assert.throws(() => lsn.toBig('1'.repeat(26)));
    assert.equal(lsn.isLsn('0'), true);
    assert.equal(lsn.norm('000123'), '123');
    assert.equal(lsn.norm(null), null);
});

test('by() sorts by LSN property', () => {
    const rows = [{ l: '100000000000000000010' }, { l: '9' }, { l: '100000000000000000002' }];
    assert.deepEqual(rows.sort(lsn.by('l')).map((r) => r.l), ['9', '100000000000000000002', '100000000000000000010']);
});
