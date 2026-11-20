// Backup file naming and path translation.
//
// Every backup file is identified in the catalog by a path RELATIVE to the
// shared backup root, e.g. "Sales/LOG/Sales_LOG_20261120_101500_sql1.trn".
// Each server sees the shared root under its own mount point (sql_backup_root),
// and the controller sees it under controller_backup_root (default BACKUP_ROOT).
//
// translatePath() is the ONLY place where paths are mapped between these
// three namespaces. Nothing else should join or strip backup roots.
import path from 'node:path';
import crypto from 'node:crypto';

const posix = path.posix;
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export const BACKUP_TYPES = Object.freeze({
    FULL: { dir: 'FULL', ext: 'bak' },
    DIFF: { dir: 'DIFF', ext: 'bak' },
    LOG: { dir: 'LOG', ext: 'trn' },
    DIVERGED: { dir: 'DIVERGED', ext: 'bak' },
});

/**
 * Filesystem-safe version of a database (or server) name. Safe names are used
 * verbatim; anything else is reduced to safe characters plus a short hash of
 * the original so that two different names can never collide.
 */
export function safeName(name) {
    if (SAFE_NAME_RE.test(name) && name !== '.' && name !== '..') return name;
    const cleaned = String(name).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_').slice(0, 60) || 'db';
    const hash = crypto.createHash('sha256').update(String(name), 'utf8').digest('hex').slice(0, 8);
    return `${cleaned}~${hash}`;
}

function stamp(date) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}_` +
        `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
    );
}

/**
 * Relative path for a new backup file:
 *   <db>/<FULL|DIFF|LOG>/<db>_<type>_<yyyyMMdd_HHmmss>_<server>.<bak|trn>
 * Timestamps are UTC so that DST changes never produce duplicate names.
 */
export function backupRelPath(dbName, type, date, serverName, suffix = '') {
    const t = BACKUP_TYPES[type];
    if (!t) throw new Error(`Unknown backup type ${type}`);
    const db = safeName(dbName);
    const srv = safeName(serverName);
    return posix.join(db, t.dir, `${db}_${type}_${stamp(date)}_${srv}${suffix}.${t.ext}`);
}

/** Relative directory holding backups of one type for a database. */
export function backupRelDir(dbName, type) {
    return posix.join(safeName(dbName), BACKUP_TYPES[type].dir);
}

/** Validates and normalizes a relative path: no absolute paths, no escaping the root. */
export function normalizeRel(rel) {
    if (typeof rel !== 'string' || rel === '') throw new Error('Empty relative path');
    if (rel.includes('\0') || rel.includes('\\')) throw new Error(`Invalid characters in path: ${rel}`);
    if (rel.startsWith('/')) throw new Error(`Expected a relative path, got ${rel}`);
    const n = posix.normalize(rel);
    if (n === '..' || n.startsWith('../') || n === '.') throw new Error(`Path escapes the backup root: ${rel}`);
    return n;
}

function rootOf(server, ns, controllerDefaultRoot) {
    if (ns === 'sql') {
        if (!server?.sql_backup_root) throw new Error('Server has no sql_backup_root');
        return posix.normalize(server.sql_backup_root).replace(/\/+$/, '') || '/';
    }
    if (ns === 'controller') {
        const r = server?.controller_backup_root || controllerDefaultRoot;
        if (!r) throw new Error('No controller backup root configured');
        return posix.normalize(r).replace(/\/+$/, '') || '/';
    }
    throw new Error(`Unknown path namespace ${ns}`);
}

/**
 * Translate a path between namespaces.
 *   from/to: 'rel' (relative to the shared root), 'sql' (as the given server's
 *   SQL Server sees it) or 'controller' (as this process sees it).
 * Throws if the path is not inside the source root.
 *
 * @param {string} p
 * @param {object} server   row from the servers table (needs sql_backup_root / controller_backup_root)
 * @param {{from:'rel'|'sql'|'controller', to:'rel'|'sql'|'controller', controllerRoot?:string}} opts
 */
export function translatePath(p, server, { from, to, controllerRoot }) {
    let rel;
    if (from === 'rel') {
        rel = normalizeRel(p);
    } else {
        const root = rootOf(server, from, controllerRoot);
        const abs = posix.normalize(String(p));
        const prefix = root === '/' ? '/' : root + '/';
        if (!abs.startsWith(prefix)) throw new Error(`Path ${p} is not under the ${from} backup root ${root}`);
        rel = normalizeRel(abs.slice(prefix.length));
    }
    if (to === 'rel') return rel;
    return posix.join(rootOf(server, to, controllerRoot), rel);
}

/**
 * True when a path (as SQL Server reports it in msdb) is a file this
 * controller would have written: under the server's backup root and matching
 * our naming pattern.
 */
const OWN_FILE_RE = /^[^/]+\/(FULL|DIFF|LOG|DIVERGED)\/[^/]+_(FULL|DIFF|LOG|DIVERGED)_\d{8}_\d{6}_[^/]+\.(bak|trn)$/;
export function isOwnBackupPath(sqlPath, server) {
    try {
        const rel = translatePath(sqlPath, server, { from: 'sql', to: 'rel' });
        return OWN_FILE_RE.test(rel);
    } catch {
        return false;
    }
}
