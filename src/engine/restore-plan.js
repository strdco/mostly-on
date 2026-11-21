// Pure helpers for restores (no I/O): MOVE targets, STANDBY undo files,
// classification of RESTORE errors and retry backoff.
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
        else throw new Error(`Backup contains a file of type ${f.type} (${f.logicalName}), which Mostly On cannot place`);
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

/** STANDBY undo file for a database on a server (SQL Server path). */
export function undoFilePath(server, dbName) {
    const dir = server.standby_root || server.default_data_path;
    if (!dir) throw new Error(`Server ${server.name} has no standby path and has not reported its default data path`);
    return sqlPathApi(dir).join(dir, `${safeName(dbName)}.tuf`);
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
