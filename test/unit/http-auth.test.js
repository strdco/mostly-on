// Exercises the HTTP layer end to end (no SQL Server needed): login,
// session cookie, CSRF and origin checks, auth guard, user accounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { openDb, closeDb } from '../../src/store/db.js';
import { hashPassword } from '../../src/crypto.js';
import { createHttpServer } from '../../src/http/server.js';
import { authRoutes } from '../../src/http/routes/auth.js';
import { miscRoutes } from '../../src/http/routes/misc.js';
import { userRoutes } from '../../src/http/routes/users.js';
import * as users from '../../src/store/repos/users.js';
import * as events from '../../src/store/repos/events.js';
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
    assert.equal(users.ensureFirstUser(cfg), 'created');
    assert.equal(users.ensureFirstUser(cfg), 'exists');
    server = createHttpServer(cfg, (r) => {
        authRoutes(r, { cfg });
        miscRoutes(r, { cfg });
        userRoutes(r, { cfg });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    closeDb();
});

/** Who /api/auth/me says is signed in with this cookie (null: nobody; it answers 200 either way). */
async function whoIs(cookie) {
    const res = await fetch(`${base}/api/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(res.status, 200);
    return (await res.json()).user;
}

async function login(password = 'test-password', username = 'admin') {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
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
    assert.equal(await whoIs(null), null, 'not signed in: an answer, not a 401');
    assert.equal(await whoIs(cookie), 'admin');
    const out =await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken } });
    assert.equal(out.status, 200);
    assert.equal(await whoIs(cookie), null);
});

test('static files and security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});

/** A logged-in client: call(method, path, body) with cookie and CSRF token. */
async function as(username, password) {
    const { res, body, cookie } = await login(password, username);
    assert.equal(res.status, 200, `login as ${username}`);
    const call = async (method, path, payload) => {
        const r = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': body.csrfToken },
            body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        return { status: r.status, body: await r.json() };
    };
    return { call, me: body, cookie };
}

test('users: a new user must choose a password first, and actions carry their name', async () => {
    const admin = await as('admin', 'test-password');
    assert.equal(admin.me.mustChangePassword, false);
    const created = await admin.call('POST', '/api/users', { username: 'alice', password: 'first-pass-1' });
    assert.equal(created.status, 201);
    assert.equal(created.body.createdBy, 'admin');
    assert.equal(created.body.mustChangePassword, true);
    assert.equal((await admin.call('POST', '/api/users', { username: 'ALICE', password: 'first-pass-1' })).status, 409, 'names ignore case');
    assert.equal((await admin.call('POST', '/api/users', { username: 'bob', password: '   ' })).status, 400, 'not blank');
    assert.equal((await admin.call('POST', '/api/users', { username: 'bob', password: 'abc' })).status, 201, 'a short first password is fine');
    const bob = await as('bob', 'abc');
    assert.equal((await bob.call('POST', '/api/auth/password', { current: 'abc', password: 'short' })).status, 400, 'their own password needs 8 characters');

    const alice = await as('alice', 'first-pass-1');
    assert.equal(alice.me.mustChangePassword, true);
    const blocked = await alice.call('PUT', '/api/settings', { 'alerts.reminder_hours': 3 });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /Change your password/);
    assert.equal((await alice.call('POST', '/api/auth/password', { current: 'wrong', password: 'alice-own-pass' })).status, 400);
    const changed = await alice.call('POST', '/api/auth/password', { current: 'first-pass-1', password: 'alice-own-pass' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.mustChangePassword, false);
    assert.equal((await alice.call('PUT', '/api/settings', { 'alerts.reminder_hours': 3 })).status, 200, 'same session works after the change');

    const audit = events.list({ peopleOnly: true });
    assert.ok(audit.some((e) => e.actor === 'alice' && e.category === 'settings'));
    assert.ok(audit.some((e) => e.actor === 'admin' && /User alice created/.test(e.message)));
    assert.ok(audit.every((e) => e.actor), 'peopleOnly leaves out what Mostly-On did by itself');
});

test('users: disabling ends sessions and blocks login; the last enabled user and yourself stay', async () => {
    const admin = await as('admin', 'test-password');
    const carol = (await admin.call('POST', '/api/users', { username: 'carol', password: 'carol-pass-1' })).body;
    const c = await as('carol', 'carol-pass-1');
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: c.cookie } })).status, 200);
    assert.equal((await admin.call('POST', `/api/users/${carol.id}/disable`)).status, 200);
    assert.equal(await whoIs(c.cookie), null, 'her session ended');
    const denied = await login('carol-pass-1', 'carol');
    assert.equal(denied.res.status, 401);
    assert.equal(denied.body.error, (await login('whatever', 'nobody')).body.error, 'same answer as an unknown user');

    const self = users.getByName('admin');
    assert.equal((await admin.call('POST', `/api/users/${self.id}/disable`)).status, 409);
    assert.equal((await admin.call('POST', `/api/users/${carol.id}/enable`)).status, 200);
    assert.equal((await login('carol-pass-1', 'carol')).res.status, 200);
});

test('users: a reset password logs the user out and must be changed', async () => {
    const admin = await as('admin', 'test-password');
    const dave = (await admin.call('POST', '/api/users', { username: 'dave', password: 'dave-pass-1' })).body;
    const d = await as('dave', 'dave-pass-1');
    await d.call('POST', '/api/auth/password', { current: 'dave-pass-1', password: 'dave-own-pass' });
    assert.equal((await admin.call('POST', `/api/users/${dave.id}/password`, { password: '' })).status, 400);
    const reset = await admin.call('POST', `/api/users/${dave.id}/password`, { password: 'dave-temp-pass' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.mustChangePassword, true);
    assert.equal(await whoIs(d.cookie), null);
    const again = await as('dave', 'dave-temp-pass');
    assert.equal(again.me.mustChangePassword, true);
});
