import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, encrypt, decrypt, safeEqual } from '../../src/crypto.js';

test('scrypt hash verifies only the right password', async () => {
    const h = await hashPassword('correct horse', { N: 1024, r: 8, p: 1, keylen: 64 });
    assert.match(h, /^scrypt:1024:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.ok(!h.includes('$'));
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifyPassword('wrong', h), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('AES-GCM round trip and tamper detection', () => {
    const key = crypto.randomBytes(32);
    const c = encrypt('s3cret pässword', key);
    assert.equal(decrypt(c, key), 's3cret pässword');
    const parts = c.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => decrypt(parts.join(':'), key));
    assert.throws(() => decrypt(c, crypto.randomBytes(32)));
});

test('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
});
