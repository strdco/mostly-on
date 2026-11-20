// Recovery forks of each managed database. A new fork starts every time the
// controller recovers a copy (RESTORE ... WITH RECOVERY during a failover).
// The active lineage is the path from the root fork to the newest fork.
import { getDb, nowIso } from '../db.js';

export function list(databaseId) {
    return getDb()
        .prepare('SELECT database_id, fork_guid, parent_fork_guid, fork_point_lsn, created_by_operation_id, created_at FROM forks WHERE database_id=? ORDER BY created_at, rowid')
        .all(databaseId);
}

export function get(databaseId, forkGuid) {
    return getDb().prepare('SELECT database_id, fork_guid, parent_fork_guid, fork_point_lsn FROM forks WHERE database_id=? AND fork_guid=?').get(databaseId, forkGuid);
}

/** Records the fork a database is on when Mostly On first sees it (no parent). */
export function ensureRoot(databaseId, forkGuid) {
    if (!forkGuid) return false;
    const existing = getDb().prepare('SELECT COUNT(*) FROM forks WHERE database_id=?').pluck().get(databaseId);
    if (existing) return false;
    getDb()
        .prepare('INSERT INTO forks (database_id, fork_guid, parent_fork_guid, fork_point_lsn, created_by_operation_id, created_at) VALUES (?, ?, NULL, NULL, NULL, ?)')
        .run(databaseId, forkGuid, nowIso());
    return true;
}

/** Starts a fresh lineage (a database that is managed again). */
export function reset(databaseId, forkGuid) {
    getDb().prepare('DELETE FROM forks WHERE database_id=?').run(databaseId);
    return ensureRoot(databaseId, forkGuid);
}

/** Records a new fork as the child of the current lineage tip. Idempotent. */
export function addChild(databaseId, { forkGuid, parentForkGuid, forkPointLsn, operationId = null }) {
    if (get(databaseId, forkGuid)) return false;
    getDb()
        .prepare('INSERT INTO forks (database_id, fork_guid, parent_fork_guid, fork_point_lsn, created_by_operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(databaseId, forkGuid, parentForkGuid, forkPointLsn, operationId, nowIso());
    return true;
}

/**
 * Active lineage, root first: [{fork_guid, fork_point_lsn}], where
 * fork_point_lsn is where that fork branched off its parent (null for the
 * root). Null when no fork has been recorded for the database.
 */
export function lineage(databaseId) {
    const rows = list(databaseId);
    if (!rows.length) return null;
    const byGuid = new Map(rows.map((r) => [r.fork_guid, r]));
    const out = [];
    let cur = rows[rows.length - 1];
    const seen = new Set();
    while (cur && !seen.has(cur.fork_guid)) {
        seen.add(cur.fork_guid);
        out.unshift({ fork_guid: cur.fork_guid, fork_point_lsn: cur.fork_point_lsn });
        cur = cur.parent_fork_guid ? byGuid.get(cur.parent_fork_guid) : null;
    }
    return out;
}

export function tip(databaseId) {
    const l = lineage(databaseId);
    return l ? l[l.length - 1].fork_guid : null;
}
