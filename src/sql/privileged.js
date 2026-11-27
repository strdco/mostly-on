// Every privileged action (BACKUP, RESTORE, ALTER DATABASE, KILL) goes through
// the signed helper procedures in master.mostly_on (sql/mostly-on-helpers.sql),
// so the SQL login Mostly-On uses never needs sysadmin. Read-only queries stay
// in tsql.js / inspect.js.
//
// Each builder returns { text, params, work } for query() or a dedicated
// connection; run()/runOn() add the readiness check and turn "procedure
// missing" errors into a plain explanation. `work` marks BACKUP and RESTORE
// statements: run() gives them the server's work connections and takes a
// place in its line (sql/slots.js, at most N at a time per server).
import { query, T } from './pool.js';
import { acquireSlot } from './slots.js';
import * as health from '../engine/health.js';
import * as serversRepo from '../store/repos/servers.js';
import { log } from '../log.js';

/** The helper procedure version this controller needs (helper_version() in the script). */
export const HELPER_VERSION = 7;

// The helpers that back up or restore, and so count against a server's limit.
const WORK = new Set(['take_backup', 'restore_database', 'restore_log', 'recover']);

function call(proc, params) {
    const names = Object.keys(params);
    return { text: `EXEC master.mostly_on.${proc}${names.length ? ' ' : ''}${names.map((n) => `@${n}=@${n}`).join(', ')};`, params, work: WORK.has(proc) };
}

/** FULL, DIFF or LOG; copyOnly for safety backups of out-of-sync copies. */
export function takeBackup({ db, type, path, name, description, copyOnly = false, continueAfterError = false }) {
    return call('take_backup', {
        db: T.sysname(db),
        type: T.nvarchar(type, 4),
        path: T.nvarchar(path, 400),
        name: T.nvarchar(name, 128),
        description: T.nvarchar(description, 255),
        copy_only: T.bit(copyOnly),
        continue_after_error: T.bit(continueAfterError),
    });
}

/** Tail-log backup at failover: 'planned' (SINGLE_USER, then NORECOVERY) or 'forced' (NO_TRUNCATE). */
export function tailLog({ db, path, name, description, mode, continueAfterError = false }) {
    return call('tail_log', {
        db: T.sysname(db),
        path: T.nvarchar(path, 400),
        name: T.nvarchar(name, 128),
        description: T.nvarchar(description, 255),
        mode: T.nvarchar(mode, 8),
        continue_after_error: T.bit(continueAfterError),
    });
}

/**
 * RESTORE DATABASE ... WITH NORECOVERY; moves: [{ from: logical name, to: path }].
 * mustNotExist: refuse if a database of that name exists (copies under a new name).
 */
export function restoreDatabase({ db, path, moves = [], replace = false, mustNotExist = false }) {
    const params = {
        db: T.sysname(db),
        path: T.nvarchar(path, 400),
        moves: T.nvarcharMax(JSON.stringify(moves.map((m) => ({ from: m.from, to: m.to })))),
        replace: T.bit(replace),
    };
    if (mustNotExist) params.must_not_exist = T.bit(true);
    return call('restore_database', params);
}

/**
 * RESTORE LOG, NORECOVERY or (with undo) STANDBY; disconnects readers first.
 * stopAt (point in time): a Date whose UTC fields are the moment in the local
 * time of the server that wrote the log (chain.stopAtLocal()).
 */
export function restoreLog({ db, path, undo = null, stopAt = null }) {
    const params = { db: T.sysname(db), path: T.nvarchar(path, 400), undo: T.nvarchar(undo, 400) };
    if (stopAt) params.stop_at = T.datetime2(stopAt);
    return call('restore_log', params);
}

/**
 * Brings a copy online (RECOVERY, MULTI_USER) and gives it its owner back: the
 * login with ownerSid, else the one named ownerName, else the fallback owner.
 * The result row is { owner_name, matched_by: 'sid'|'name'|'fallback'|'failed', note }.
 */
export function recover({ db, ownerSid = null, ownerName = null }) {
    return call('recover', {
        db: T.sysname(db),
        owner_sid: T.varbinary(ownerSid ? Buffer.from(ownerSid.replace(/^0x/i, ''), 'hex') : null, 85),
        owner_name: T.sysname(ownerName),
    });
}

/** 'OFFLINE' | 'ONLINE_RESTRICTED' | 'MULTI_USER' */
export function setState({ db, state }) {
    return call('set_state', { db: T.sysname(db), state: T.nvarchar(state, 20) });
}

/** Drops a copy that is not in use: only a RESTORING or read-only (STANDBY) one; the procedure refuses any other. */
export function dropDatabase({ db }) {
    return call('drop_database', { db: T.sysname(db) });
}

export const headerOnly = ({ path }) => call('header_only', { path: T.nvarchar(path, 400) });
export const fileListOnly = ({ path }) => call('filelist_only', { path: T.nvarchar(path, 400) });
export const purgeBackupHistory = ({ keepDays }) => call('purge_backup_history', { keep_days: T.int(keepDays) });

const ERRORLOG_MAX = 1800;
/** An informational line in the SQL Server error log (and, on Windows, the Application event log). */
export const writeErrorLog = ({ message }) => call('write_errorlog', { message: T.nvarchar(String(message).slice(0, ERRORLOG_MAX), ERRORLOG_MAX) });

/**
 * Copies an audit event to a server's error log (events.setErrorLogWriter).
 * Best effort: a server that is unreachable, disabled or not set up is
 * skipped, and a failure is only logged at debug level. Never throws.
 */
export async function writeErrorLogBestEffort(serverId, message) {
    try {
        const s = serversRepo.get(serverId);
        if (!s || s.removed_at || !s.enabled || !health.getHealth(serverId)?.ok) return;
        await run(serverId, writeErrorLog({ message }), { timeoutMs: 15_000 });
    } catch (err) {
        log.debug('Could not copy an event to the SQL Server error log', { serverId, err });
    }
}

/** Throws a plain explanation if the last health check found the helpers missing or out of date. */
export function assertReady(serverId) {
    const setup = health.getHealth(serverId)?.setup;
    if (setup && !setup.ready) {
        const name = serversRepo.get(serverId)?.name ?? `server ${serverId}`;
        throw Object.assign(new Error(`Mostly-On cannot back up or restore on ${name}: ${setup.problems[0]} Run the setup script for ${name} (Servers page)`), {
            status: 409,
            expose: true,
            setupProblem: true,
        });
    }
}

// 2812: could not find stored procedure; 229: EXECUTE permission denied.
function explain(err, serverId) {
    const n = err?.number ?? err?.originalError?.info?.number;
    if (n !== 2812 && !(n === 229 && /mostly_on/.test(err.message))) return err;
    const name = serversRepo.get(serverId)?.name ?? `server ${serverId}`;
    return Object.assign(new Error(`Mostly-On's helper procedures are missing on ${name}, or its login may not run them. Run the setup script for ${name} (Servers page): ${err.message}`), {
        number: n,
        cause: err,
        setupProblem: true,
    });
}

/**
 * Runs a built call on the server. A backup or restore (c.work) waits for its
 * turn on that server first (at most N at a time), unless opts.priority (a
 * failover or rollback: never waits). Other calls run right away.
 * @param {{timeoutMs?:number, onInfo?:(m:string)=>void, priority?:boolean,
 *          abortWhen?:()=>string|false, onWait?:(text:string)=>void}} [opts]
 *   abortWhen: while still waiting, a reason to give way (throws with err.gaveWay).
 *   onWait: progress text while waiting ("Waiting for a free connection to ...").
 *   onStart: called right before the statement is sent, after any wait for its turn.
 */
export async function run(serverId, c, opts = {}) {
    assertReady(serverId);
    const { priority = false, abortWhen = null, onWait = null, onStart = null, ...queryOpts } = opts;
    if (!c.work || priority) {
        onStart?.();
        return runQuery(serverId, c, c.work ? { ...queryOpts, pool: 'work' } : queryOpts);
    }
    const name = serversRepo.get(serverId)?.name ?? `server ${serverId}`;
    const release = await acquireSlot(serverId, {
        abortWhen,
        onWait: onWait && ((s) => onWait(`Waiting for a free connection to ${name}: ${s.running} of ${s.limit} in use${s.ahead ? `, ${s.ahead} ahead in line` : ''}`)),
    });
    try {
        assertReady(serverId); // the setup may have changed while it waited
        onStart?.();
        return await runQuery(serverId, c, { ...queryOpts, pool: 'work' });
    } finally {
        release();
    }
}

async function runQuery(serverId, c, opts) {
    try {
        return await query(serverId, c.text, c.params, opts);
    } catch (err) {
        throw explain(err, serverId);
    }
}

/** Runs a built call with a query function from withDedicated(). */
export async function runOn(q, serverId, c, opts) {
    assertReady(serverId);
    try {
        return await q(c.text, c.params, opts);
    } catch (err) {
        throw explain(err, serverId);
    }
}
