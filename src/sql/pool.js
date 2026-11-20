// Connections to managed SQL Servers.
//
// One mssql ConnectionPool per server (database context: master). Short
// statements use the default 30 s request timeout; BACKUP/RESTORE pass
// { timeoutMs: 0 } for no timeout. withDedicated() opens a private single
// connection for batches that must not share a session with anything else
// (SINGLE_USER + tail-log backup).
//
// All values go in as typed parameters. Callers never interpolate input into
// SQL text.
import sql from 'mssql';
import * as serversRepo from '../store/repos/servers.js';
import { log } from '../log.js';

let secretKey = null;
const pools = new Map(); // serverId -> Promise<ConnectionPool>

export function initPools(key) {
    secretKey = key;
}

/** Parameter type helpers. */
export const T = {
    sysname: (v) => ({ type: sql.NVarChar(128), value: v }),
    nvarchar: (v, n = 4000) => ({ type: sql.NVarChar(n), value: v }),
    nvarcharMax: (v) => ({ type: sql.NVarChar(sql.MAX), value: v }),
    int: (v) => ({ type: sql.Int, value: v }),
    bigint: (v) => ({ type: sql.BigInt, value: v }),
    bit: (v) => ({ type: sql.Bit, value: v ? 1 : 0 }),
    uniqueidentifier: (v) => ({ type: sql.UniqueIdentifier, value: v }),
    datetime2: (v) => ({ type: sql.DateTime2(3), value: v }),
    // LSNs are passed as varchar and converted server-side to numeric(25,0).
    lsn: (v) => ({ type: sql.VarChar(25), value: v }),
};

function poolConfig(s, { connectTimeoutMs = 15000, max = 6 } = {}) {
    return {
        server: s.host,
        port: s.port,
        user: s.username,
        password: s.password,
        database: 'master',
        connectionTimeout: connectTimeoutMs,
        requestTimeout: 30000,
        options: {
            encrypt: !!s.encrypt,
            trustServerCertificate: !!s.trust_server_cert,
            appName: 'mostly-on',
            useUTC: true,
            abortTransactionOnError: true,
        },
        pool: { max, min: 0, idleTimeoutMillis: 60000 },
    };
}

function loadServer(serverId) {
    const s = serversRepo.getWithSecret(serverId, secretKey);
    if (!s) throw new Error(`Unknown server id ${serverId}`);
    return s;
}

export async function getPool(serverId) {
    let p = pools.get(serverId);
    if (!p) {
        const s = loadServer(serverId);
        const pool = new sql.ConnectionPool(poolConfig(s));
        pool.on('error', (err) => log.warn('SQL pool error', { serverId, err }));
        p = pool.connect().catch((err) => {
            pools.delete(serverId);
            throw err;
        });
        pools.set(serverId, p);
    }
    return p;
}

/** Drop a server's pool (after its settings change or on connection failure). */
export async function resetPool(serverId) {
    const p = pools.get(serverId);
    pools.delete(serverId);
    if (p) {
        try {
            (await p).close();
        } catch {
            /* already broken */
        }
    }
}

export async function closeAll() {
    await Promise.allSettled([...pools.keys()].map((id) => resetPool(id)));
}

function isConnectionError(err) {
    return ['ESOCKET', 'ECONNCLOSED', 'ETIMEOUT', 'ELOGIN', 'ENOTOPEN', 'ECONNRESET'].includes(err?.code);
}

function bind(request, params) {
    for (const [name, p] of Object.entries(params || {})) {
        request.input(name, p.type, p.value);
    }
}

/**
 * Run a parameterized statement on a server. Returns { recordsets, recordset, rowsAffected }.
 * @param {number} serverId
 * @param {string} text   T-SQL with @named parameters
 * @param {object} [params]  { name: T.xxx(value) }
 * @param {{timeoutMs?:number, onInfo?:(msg:string)=>void}} [opts]
 */
export async function query(serverId, text, params = {}, opts = {}) {
    const pool = await getPool(serverId);
    const req = new sql.Request(pool, opts.timeoutMs !== undefined ? { requestTimeout: opts.timeoutMs } : undefined);
    if (opts.onInfo) req.on('info', (m) => opts.onInfo(m.message));
    bind(req, params);
    try {
        return await req.query(text);
    } catch (err) {
        if (isConnectionError(err)) await resetPool(serverId);
        throw err;
    }
}

/**
 * Open a private connection (no pooling) and pass a runner to fn. The
 * connection is closed afterwards whatever happens.
 */
export async function withDedicated(serverId, fn, { connectTimeoutMs = 15000 } = {}) {
    const s = loadServer(serverId);
    const pool = new sql.ConnectionPool(poolConfig(s, { connectTimeoutMs, max: 1 }));
    pool.on('error', () => {});
    await pool.connect();
    try {
        return await fn(async (text, params = {}, opts = {}) => {
            const req = new sql.Request(pool, opts.timeoutMs !== undefined ? { requestTimeout: opts.timeoutMs } : undefined);
            if (opts.onInfo) req.on('info', (m) => opts.onInfo(m.message));
            bind(req, params);
            return req.query(text);
        });
    } finally {
        try {
            await pool.close();
        } catch {
            /* ignore */
        }
    }
}

/** Connect with ad-hoc settings (used by "test connection" before saving). */
export async function testConnection(s) {
    const pool = new sql.ConnectionPool(poolConfig(s, { connectTimeoutMs: 10000, max: 1 }));
    pool.on('error', () => {});
    await pool.connect();
    try {
        const r = await pool.request().query("SELECT CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')) AS product_version;");
        return r.recordset[0];
    } finally {
        await pool.close().catch(() => {});
    }
}

/** Short, user-presentable error text from an mssql/tedious error. */
export function sqlErrorText(err) {
    if (!err) return 'Unknown error';
    const parts = [];
    if (err.number) parts.push(`Msg ${err.number}`);
    parts.push(err.message || String(err));
    const pre = err.precedingErrors?.map((e) => e.message).filter(Boolean);
    if (pre?.length) parts.push(`(${pre.join(' | ')})`);
    return parts.join(': ').slice(0, 2000);
}
