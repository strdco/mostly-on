// Exercises the HTTP layer end to end (no SQL Server needed): login,
// session cookie, CSRF and origin checks, auth guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { openDb, closeDb } from '../../src/store/db.js';
import { hashPassword } from '../../src/crypto.js';
import { createHttpServer } from '../../src/http/server.js';
import { authRoutes } from '../../src/http/routes/auth.js';
import { miscRoutes } from '../../src/http/routes/misc.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
let server;
let base;

before(async () => {
    process.env.ADMIN_USER = 'admin';
    process.env.ADMIN_PASSWORD_HASH = await hashPassword('test-password', { N: 1024, r: 8, p: 1, keylen: 64 });
    process.env.SECRET_KEY = crypto.randomBytes(32).toString('base64');
    process.env.PUBLIC_URL = 'http://localhost:1';
    const cfg = loadConfig();
    openDb(':memory:');
    server = createHttpServer(cfg, (r) => {
        authRoutes(r, { cfg });
        miscRoutes(r, { cfg });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    closeDb();
});

async function login(password = 'test-password') {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
    });
    const body = await res.json();
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    return { res, body, cookie };
}

test('API requires a session', async () => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 401);
    const res2 = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res2.status, 401);
});

test('wrong password is rejected', async () => {
    const { res, cookie } = await login('nope');
    assert.equal(res.status, 401);
    assert.equal(cookie, undefined);
});

test('login sets an HttpOnly SameSite=Strict cookie and returns a CSRF token', async () => {
    const { res, body } = await login();
    assert.equal(res.status, 200);
    assert.ok(body.csrfToken);
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
});

test('state-changing requests need the CSRF token', async () => {
    const { body, cookie } = await login();
    const put = (headers) =>
        fetch(`${base}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
            body: JSON.stringify({ 'alerts.reminder_hours': 2 }),
        });
    assert.equal((await put({})).status, 403);
    assert.equal((await put({ 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await put({ 'X-CSRF-Token': body.csrfToken, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await put({ 'X-CSRF-Token': body.csrfToken, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const ok = await put({ 'X-CSRF-Token': body.csrfToken, Origin: 'http://localhost:1' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json())['alerts.reminder_hours'], 2);
});

test('GET works with the cookie alone; logout ends the session', async () => {
    const { body, cookie } = await login();
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200);
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken } });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401);
});

test('static files and security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});
