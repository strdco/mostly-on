// Connections to managed SQL Servers.
//
// Two mssql ConnectionPools per server (database context: master):
//  - control: health checks and every short query (metadata, state, file
//    headers). Backups and restores never use it, so a busy server is never
//    mistaken for an unreachable one.
//  - work: BACKUP and RESTORE statements. How many run at once is decided by
//    sql/slots.js (the per-server limit), not by this pool: it is sized above
//    the highest limit, so failovers and rollbacks (which skip the line)
//    still get a connection, and waits for one do not time out after 30 s.
// Short statements use the default 30 s request timeout; BACKUP/RESTORE pass
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
const POOLS = {
    control: { max: 4 },
    work: { max: 16, acquireTimeoutMillis: 10 * 60_000 },
};
const pools = { control: new Map(), work: new Map() }; // kind -> serverId -> Promise<ConnectionPool>

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
    varbinary: (v, n = 8000) => ({ type: sql.VarBinary(n), value: v }),
    uniqueidentifier: (v) => ({ type: sql.UniqueIdentifier, value: v }),
    datetime2: (v) => ({ type: sql.DateTime2(3), value: v }),
    // LSNs are passed as varchar and converted server-side to numeric(25,0).
    lsn: (v) => ({ type: sql.VarChar(25), value: v }),
};

export function poolConfig(s, { connectTimeoutMs = 15000, max = POOLS.control.max, acquireTimeoutMillis } = {}) {
    return {
        server: s.host,
        // A named instance is found through the SQL Server Browser (UDP 1434); the driver then must not get a port.
        port: s.instance_name ? undefined : s.port,
        user: s.username,
        password: s.password,
        database: 'master',
        connectionTimeout: connectTimeoutMs,
        requestTimeout: 30000,
        options: {
            encrypt: !!s.encrypt,
            trustServerCertificate: !!s.trust_server_cert,
            appName: 'mostly-on',
            ...(s.instance_name ? { instanceName: s.instance_name } : {}),
            useUTC: true,
            abortTransactionOnError: true,
        },
        pool: { max, min: 0, idleTimeoutMillis: 60000, ...(acquireTimeoutMillis ? { acquireTimeoutMillis } : {}) },
    };
}

function loadServer(serverId) {
    const s = serversRepo.getWithSecret(serverId, secretKey);
    if (!s) throw new Error(`Unknown server id ${serverId}`);
    return s;
}

/** kind: 'control' (short queries, health checks) or 'work' (BACKUP/RESTORE). */
export async function getPool(serverId, kind = 'control') {
    const byServer = pools[kind];
    let p = byServer.get(serverId);
    if (!p) {
        const s = loadServer(serverId);
        const pool = new sql.ConnectionPool(poolConfig(s, POOLS[kind]));
        pool.on('error', (err) => log.warn('SQL pool error', { serverId, pool: kind, err }));
        p = pool.connect().catch((err) => {
            byServer.delete(serverId);
            throw err;
        });
        byServer.set(serverId, p);
    }
    return p;
}

/** Drop a server's pools (after its settings change or on connection failure). */
export async function resetPool(serverId) {
    for (const byServer of Object.values(pools)) {
        const p = byServer.get(serverId);
        byServer.delete(serverId);
        if (p) {
            try {
                (await p).close();
            } catch {
                /* already broken */
            }
        }
    }
}

export async function closeAll() {
    const ids = new Set(Object.values(pools).flatMap((m) => [...m.keys()]));
    await Promise.allSettled([...ids].map((id) => resetPool(id)));
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
 * @param {{timeoutMs?:number, onInfo?:(msg:string)=>void, pool?:'control'|'work'}} [opts]
 */
export async function query(serverId, text, params = {}, opts = {}) {
    const pool = await getPool(serverId, opts.pool ?? 'control');
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

const TEST_CONNECT_TIMEOUT_MS = 10_000;

/** Connect with ad-hoc settings (used by "test connection" before saving). */
export async function testConnection(s) {
    const pool = new sql.ConnectionPool(poolConfig(s, { connectTimeoutMs: TEST_CONNECT_TIMEOUT_MS, max: 1 }));
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

/** Every error code in err and its causes (the driver wraps socket errors, sometimes in an AggregateError). */
function errorCodes(err, depth = 0) {
    if (!err || depth > 4) return [];
    const inner = [...(err.errors ?? []), err.cause, err.originalError !== err ? err.originalError : null];
    return [err.code, ...inner.flatMap((e) => errorCodes(e, depth + 1))].filter(Boolean);
}

/**
 * Why testConnection(s) failed, saying what to check: for the Register dialog,
 * where it is usually a typo. Anything not recognised gets the driver's own text.
 */
export function connectErrorText(s, err) {
    const codes = new Set(errorCodes(err));
    const where = s.instance_name ? `${s.host}\\${s.instance_name}` : `${s.host}:${s.port}`;
    if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
        return `Mostly-On could not find a computer called ${s.host}. Check the host name.` +
            (s.host.includes('.') ? '' : ' If the name works elsewhere, try its full name (with the domain) or its IP address: Mostly-On looks it up from inside its container.');
    }
    if (codes.has('ECONNREFUSED')) {
        const port = s.instance_name ? `the port of the instance ${s.instance_name}` : `port ${s.port}`;
        return `${s.host} refused the connection: nothing accepts connections on ${port} there. Check the port, and that SQL Server is running and accepts TCP/IP connections.` +
            (/^(localhost|127\.|::1$)/i.test(s.host) ? ' Note that localhost is the Mostly-On container itself: use the SQL Server’s host name or IP address.' : '');
    }
    if (codes.has('ELOGIN')) {
        // SQL Server tells the client no more than this on purpose; its error log on the server says why.
        if (/^Login failed for user '.*'\.$/.test(err.message)) {
            return `${where} turned down the login ${s.username}. Either the login does not exist there yet (create it first, with CREATE LOGIN), the password is different, ` +
                `or the server only allows Windows authentication. The SQL Server error log on ${s.host} says which.`;
        }
        return `${where} turned down the login ${s.username}: ${err.message}`;
    }
    if ([...codes].some((c) => /CERT|SIGNATURE/.test(c))) {
        return `${where} uses a certificate Mostly-On does not trust (${err.message.replace(/^.* - /, '')}). Tick Trust server certificate under More options, or give the server a trusted certificate.`;
    }
    if (codes.has('EHOSTUNREACH') || codes.has('ENETUNREACH')) {
        return `Mostly-On has no network route to ${s.host}. Check the host name or IP address, and that the network lets Mostly-On reach it.`;
    }
    if (codes.has('ETIMEOUT') || codes.has('ETIMEDOUT')) {
        const seconds = TEST_CONNECT_TIMEOUT_MS / 1000;
        if (s.instance_name) {
            return `No answer from ${where} within ${seconds} seconds. Mostly-On finds a named instance's port through the SQL Server Browser service (UDP port 1434): ` +
                'check the instance name, that the service is running, and that no firewall blocks it. Or leave the instance name empty and enter the port instead.';
        }
        return `No answer from ${where} within ${seconds} seconds. Check the host name and port, and that no firewall blocks connections from Mostly-On to SQL Server.`;
    }
    return `Mostly-On could not connect to ${where}: ${sqlErrorText(err)}`;
}
