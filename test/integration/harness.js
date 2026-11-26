// Integration test harness: an isolated docker compose project (own name,
// volumes, host ports and freshly generated secrets) so it never touches a
// dev stack, an HTTP client for the Mostly-On API, and direct SQL access to
// both SQL Server containers for assertions.
//
// Environment:
//   IT_PROJECT   compose project name (default mostly-on-it)
//   IT_KEEP=1    leave the stack running afterwards (inspect it, or rerun with IT_REUSE=1)
//   IT_REUSE=1   use the running stack and secrets from the last run instead of starting fresh
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sql from 'mssql';
import { hashPassword } from '../../src/crypto.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const PROJECT = process.env.IT_PROJECT || 'mostly-on-it';
export const PORTS = { controller: 18080, sql1: 24331, sql2: 24332, sql3: 24333, mock: 19911 };
const BASE = `http://localhost:${PORTS.controller}`;
const MOCK = `http://localhost:${PORTS.mock}`;
const STATE_FILE = path.join(os.tmpdir(), `${PROJECT}.json`); // secrets of the current stack, for IT_REUSE
const ENV_FILE = path.join(os.tmpdir(), `${PROJECT}.env`);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh secrets for a new stack (written to a temp env file for compose). */
async function newSecrets() {
    const adminPassword = crypto.randomBytes(18).toString('base64url');
    const saPassword = `It-${crypto.randomBytes(12).toString('base64url')}-9a`;
    const moPassword = `Mo-${crypto.randomBytes(12).toString('base64url')}-7b`;
    const env = {
        COMPOSE_PROJECT_NAME: PROJECT,
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD_HASH: await hashPassword(adminPassword),
        SECRET_KEY: crypto.randomBytes(32).toString('base64'),
        PUBLIC_URL: BASE,
        MSSQL_SA_PASSWORD: saPassword,
        MOSTLY_ON_SQL_PASSWORD: moPassword,
        CONTROLLER_PORT: PORTS.controller,
        SQL1_PORT: PORTS.sql1,
        SQL2_PORT: PORTS.sql2,
        SQL3_PORT: PORTS.sql3, // the demo compose file has a sql3; keep it off the dev stack's port
        MOCK_PUSHOVER_PORT: PORTS.mock,
        LOG_LEVEL: 'info',
        TZ: 'UTC',
    };
    fs.writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const secrets = { adminPassword, saPassword, moPassword };
    fs.writeFileSync(STATE_FILE, JSON.stringify(secrets), { mode: 0o600 });
    return secrets;
}

/** Runs docker compose for the test project; throws with its output on failure. */
export function compose(...args) {
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '--env-file', ENV_FILE, '-f', 'docker-compose.yml', '-f', 'docker-compose.demo.yml', '-f', 'docker-compose.test.yml', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
    return r.stdout;
}

/** Polls `fn` until it returns a truthy value; throws after `timeout` ms, naming what it waited for. */
export async function waitFor(what, fn, { timeout = 120_000, interval = 1000 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (err) {
            last = err;
        }
        if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeout / 1000)} s waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
        await sleep(interval);
    }
}

/** Starts the stack (fresh unless IT_REUSE=1) and returns its secrets. */
export async function startStack() {
    if (process.env.IT_REUSE === '1' && fs.existsSync(STATE_FILE) && fs.existsSync(ENV_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    if (fs.existsSync(ENV_FILE)) {
        try {
            compose('down', '-v', '--remove-orphans');
        } catch {
            /* nothing left from an earlier run */
        }
    }
    const secrets = await newSecrets();
    compose('up', '-d', '--build');
    return secrets;
}

export function stopStack() {
    if (process.env.IT_KEEP === '1') {
        console.log(`IT_KEEP=1: stack ${PROJECT} left running on ${BASE} (admin password in ${STATE_FILE})`);
        return;
    }
    compose('down', '-v', '--remove-orphans');
}

// --- SQL --------------------------------------------------------------------------

/** One query against sql1 or sql2 as sa; returns the first recordset. */
export function sqlQuery(saPassword, server, text, params = {}) {
    return sqlAs('sa', saPassword, server, text, params);
}

/** One query as any login. */
export async function sqlAs(user, password, server, text, params = {}) {
    const pool = new sql.ConnectionPool({
        server: 'localhost',
        port: PORTS[server],
        user,
        password,
        database: 'master',
        options: { encrypt: true, trustServerCertificate: true },
        connectionTimeout: 5000,
        requestTimeout: 120_000,
        pool: { max: 1 },
    });
    await pool.connect();
    try {
        const req = pool.request();
        for (const [k, v] of Object.entries(params)) req.input(k, v);
        return (await req.query(text)).recordset;
    } finally {
        await pool.close();
    }
}

// --- API --------------------------------------------------------------------------

export class Api {
    constructor() {
        this.cookie = null;
        this.csrf = null;
    }

    /** Returns the login answer ({ user, csrfToken, mustChangePassword }). */
    async login(password, username = 'admin') {
        const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        if (!r.ok) throw new Error(`login failed: HTTP ${r.status} ${await r.text()}`);
        this.cookie = r.headers.get('set-cookie').split(';')[0];
        const me = await r.json();
        this.csrf = me.csrfToken;
        return me;
    }

    async call(method, url, body) {
        const r = await fetch(`${BASE}${url}`, {
            method,
            headers: { Cookie: this.cookie, 'X-CSRF-Token': this.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        const data = text ? JSON.parse(text) : null;
        if (!r.ok) throw Object.assign(new Error(`${method} ${url}: HTTP ${r.status} ${data?.error || text}`), { status: r.status, data });
        return data;
    }

    get = (url) => this.call('GET', url);
    post = (url, body = {}) => this.call('POST', url, body);
    put = (url, body = {}) => this.call('PUT', url, body);

    /** Waits for an operation to finish; returns it. */
    waitOp(id, timeout = 600_000) {
        return waitFor(`operation #${id}`, async () => {
            const op = await this.get(`/api/operations/${id}`);
            return ['running', 'queued'].includes(op.status) ? null : op;
        }, { timeout });
    }
}

/** True once the controller answers HTTP (401 before login is fine). */
export async function controllerUp() {
    try {
        const r = await fetch(`${BASE}/api/auth/me`);
        return r.status === 200 || r.status === 401;
    } catch {
        return false;
    }
}

// --- mock Pushover ------------------------------------------------------------------

export async function mockMessages() {
    const r = await fetch(`${MOCK}/messages`);
    return r.json();
}

/** A short description of a failed operation, for assertion messages. */
export function opSummary(op) {
    return `#${op.id} ${op.type} ${op.status}: ${op.error || ''}\n${op.steps.map((s) => `  ${s.status} ${s.name}: ${s.detail || s.error || ''}`).join('\n')}`;
}
