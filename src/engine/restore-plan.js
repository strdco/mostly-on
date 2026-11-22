// Pure helpers for restores (no I/O): MOVE targets, STANDBY undo files,
// classification of RESTORE errors, retry backoff, and restore delays.
import { safeName, sqlPathApi } from '../paths.js';

const SAFE_FILE_RE = /^[A-Za-z0-9_.-]{1,120}$/;

function baseName(p) {
    return String(p).split(/[\\/]/).pop();
}

/**
 * MOVE clauses for restoring a backup on a target server: data files go to
 * the target's default data path, log files to its default log path. File
 * names keep the primary's base name (so the layout looks the same on every
 * replica), sanitized and made unique.
 *
 * @param {{logicalName:string, physicalName:string, type:string, fileId:number}[]} fileList  RESTORE FILELISTONLY
 * @param {{defaultDataPath:string, defaultLogPath:string, dbName:string}} target
 * @returns {{from:string, to:string}[]}
 */
export function buildMoves(fileList, { defaultDataPath, defaultLogPath, dbName }) {
    if (!defaultDataPath || !defaultLogPath) throw new Error('The target server has not reported its default data and log paths yet (is it reachable?)');
    const used = new Set();
    return fileList.map((f) => {
        let dir;
        if (f.type === 'D' || f.type === 'S') dir = defaultDataPath;
        else if (f.type === 'L') dir = defaultLogPath;
        else throw new Error(`Backup contains a file of type ${f.type} (${f.logicalName}), which Mostly-On cannot place`);
        let name = baseName(f.physicalName);
        if (!SAFE_FILE_RE.test(name) || name === '.' || name === '..') {
            const ext = f.type === 'L' ? '.ldf' : f.type === 'S' ? '' : f.fileId === 1 ? '.mdf' : '.ndf';
            name = `${safeName(dbName)}_${safeName(f.logicalName)}${ext}`;
        }
        if (used.has(name.toLowerCase())) {
            const dot = name.lastIndexOf('.');
            name = dot > 0 ? `${name.slice(0, dot)}_${f.fileId}${name.slice(dot)}` : `${name}_${f.fileId}`;
        }
        used.add(name.toLowerCase());
        return { from: f.logicalName, to: sqlPathApi(dir).join(dir, name) };
    });
}

/**
 * MOVE clauses for a copy restored under a new name next to the original:
 * every file gets a name derived from the new database name, so nothing
 * collides with the original's files ("Sales_20261121_1430.mdf",
 * "Sales_20261121_1430_log.ldf", "Sales_20261121_1430_Archive.ndf").
 */
export function copyMoves(fileList, { defaultDataPath, defaultLogPath, newName }) {
    if (!defaultDataPath || !defaultLogPath) throw new Error('The target server has not reported its default data and log paths yet (is it reachable?)');
    const base = safeName(newName);
    const used = new Set();
    let firstLog = true;
    return fileList.map((f) => {
        let dir;
        let name;
        if (f.type === 'D') {
            dir = defaultDataPath;
            name = f.fileId === 1 ? `${base}.mdf` : `${base}_${safeName(f.logicalName)}.ndf`;
        } else if (f.type === 'L') {
            dir = defaultLogPath;
            name = firstLog ? `${base}_log.ldf` : `${base}_${safeName(f.logicalName)}.ldf`;
            firstLog = false;
        } else if (f.type === 'S') {
            dir = defaultDataPath;
            name = `${base}_${safeName(f.logicalName)}`;
        } else {
            throw new Error(`Backup contains a file of type ${f.type} (${f.logicalName}), which Mostly-On cannot place`);
        }
        if (used.has(name.toLowerCase())) {
            const dot = name.lastIndexOf('.');
            name = dot > 0 ? `${name.slice(0, dot)}_${f.fileId}${name.slice(dot)}` : `${name}_${f.fileId}`;
        }
        used.add(name.toLowerCase());
        return { from: f.logicalName, to: sqlPathApi(dir).join(dir, name) };
    });
}

/**
 * MOVE clauses for restoring a database over itself (RESTORE ... REPLACE):
 * each file goes back where the database keeps it now (matched by logical
 * name), files it does not have yet go where buildMoves() puts them. Files
 * already at the path the backup names need no MOVE.
 *
 * @param {object[]} fileList     RESTORE FILELISTONLY
 * @param {{logicalName:string, physicalName:string}[]} current  the database's files on the server now
 * @param {{defaultDataPath:string, defaultLogPath:string, dbName:string}} target
 */
export function inPlaceMoves(fileList, current, target) {
    const now = new Map(current.map((f) => [f.logicalName.toLowerCase(), f.physicalName]));
    const missing = fileList.filter((f) => !now.has(f.logicalName.toLowerCase()));
    const fallback = new Map(missing.length ? buildMoves(missing, target).map((m) => [m.from, m.to]) : []);
    return fileList
        .map((f) => ({ from: f.logicalName, to: now.get(f.logicalName.toLowerCase()) ?? fallback.get(f.logicalName), backupPath: f.physicalName }))
        .filter((m) => m.to !== m.backupPath)
        .map(({ from, to }) => ({ from, to }));
}

/**
 * STANDBY undo file for a database on a server (SQL Server path): <db>.tuf, or
 * <db>.<stamp>.tuf for a new one (see standbyUndoFile()).
 */
export function undoFilePath(server, dbName, stamp = null) {
    const dir = server.standby_root || server.default_data_path;
    if (!dir) throw new Error(`Server ${server.name} has no standby path and has not reported its default data path`);
    return sqlPathApi(dir).join(dir, `${safeName(dbName)}${stamp ? `.${stamp}` : ''}.tuf`);
}

/**
 * The undo file for the next STANDBY log restore on a readable copy.
 *
 * SQL Server lets a login that is not sysadmin reuse the copy's current undo
 * file or create a new one, but refuses to overwrite a file an earlier copy
 * left behind (error 3441, "its standby file was inaccessible", OS error
 * 1244), and nothing inside SQL Server can delete it. So:
 *  - a copy that is readable now keeps the file it uses: `recorded`, or for
 *    a copy made before this was recorded, the plain <db>.tuf it always used;
 *  - a copy that is not readable yet (just added, reinitialized, rolled back,
 *    switched to readable) starts a new file, <db>.<UTC time>.tuf.
 * A recorded file outside the current standby folder (the folder setting
 * changed) is replaced by a new one too; a readable copy may switch to a new
 * file at any restore.
 *
 * @param {{server:object, dbName:string, live:{standby:boolean}|null, recorded:string|null, now?:number}} p
 */
export function standbyUndoFile({ server, dbName, live, recorded, now = Date.now() }) {
    const current = undoFilePath(server, dbName);
    if (live?.standby) {
        const api = sqlPathApi(current);
        if (!recorded) return current;
        if (api.dirname(recorded) === api.dirname(current)) return recorded;
    }
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261122T181530Z
    return undoFilePath(server, dbName, stamp);
}

/** Every SQL error number in an mssql error (including preceding errors). */
export function errorNumbers(err) {
    const nums = [];
    for (const e of [err, ...(err?.precedingErrors || [])]) {
        if (e?.number) nums.push(e.number);
        if (e?.originalError?.info?.number) nums.push(e.originalError.info.number);
    }
    return nums;
}

/**
 * What a failed RESTORE means for shipping:
 *   already_applied  4326: the log ends before the database's position
 *   too_recent       4305: the log starts after the position (gap)
 *   cannot_open      3201: backup file cannot be opened
 *   in_use           3101: readers hold the database (STANDBY)
 *   wrong_fork       4330: the log is on a recovery path the database is not on
 *   connection       the server could not be reached
 *   other            anything else
 */
export function classifyRestoreError(err) {
    const nums = errorNumbers(err);
    if (nums.includes(4326)) return 'already_applied';
    if (nums.includes(4305)) return 'too_recent';
    if (nums.includes(3201)) return 'cannot_open';
    if (nums.includes(3101)) return 'in_use';
    if (nums.includes(4330)) return 'wrong_fork';
    if (['ESOCKET', 'ECONNCLOSED', 'ETIMEOUT', 'ELOGIN', 'ENOTOPEN', 'ECONNRESET'].includes(err?.code)) return 'connection';
    return 'other';
}

const BACKOFF_S = [30, 60, 120, 300, 600, 900];

/** Delay before retry number `failures` (1-based). */
export function backoffMs(failures) {
    return BACKOFF_S[Math.min(Math.max(failures, 1), BACKOFF_S.length) - 1] * 1000;
}

// --- restore delay and pause (a secondary kept deliberately behind) -----------------

/** Longest restore delay a secondary may have: 7 days. */
export const MAX_RESTORE_DELAY_MINUTES = 7 * 24 * 60;
/** Longest pause of a delayed secondary: the share keeps every log it has not restored. */
export const MAX_PAUSE_HOURS = 24;

/**
 * Epoch ms from which a log backup may be restored on a secondary kept
 * `delayMinutes` behind (0: right away). Measured from when the backup
 * finished; a catalog row without that time falls back to when it was
 * recorded (never earlier). With no time at all it is due now: a delayed
 * copy must never stall for good.
 */
export function logDueAt(file, delayMinutes) {
    if (!(delayMinutes > 0)) return 0;
    const t = Date.parse(file?.backup_finish ?? file?.created_at ?? '');
    return Number.isFinite(t) ? t + delayMinutes * 60_000 : 0;
}

/** Whether a secondary's restores are paused at `now` (epoch ms). */
export function isPaused(rep, now = Date.now()) {
    const until = Date.parse(rep?.restores_paused_until ?? '');
    return Number.isFinite(until) && until > now;
}
