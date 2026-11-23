// Managed databases, their replicas, and databases discovered on servers.
import { getDb, nowIso, tx } from '../db.js';
import * as settings from './settings.js';
import { nextRun } from '../../engine/schedule-math.js';
import { dbLabel, isSystemName, manageKind } from '../../engine/backup-rules.js';

// backup_only_server_id is set for a backups-only database (see engine/backup-rules.js):
// it belongs to that one server. NULL = log shipped, identified by name on every server.
const DB_COLS = `d.id, d.name, d.family_guid, d.status, d.owner_sid, d.owner_name, d.owner_fallback,
    d.retention_full_days, d.retention_diff_days, d.retention_log_days, d.created_at, d.updated_at,
    d.backup_only_server_id, bs.name AS backup_only_server_name`;
const DB_FROM = 'databases AS d LEFT JOIN servers AS bs ON bs.id=d.backup_only_server_id';

export function list({ includeUnmanaged = false } = {}) {
    return getDb()
        .prepare(`SELECT ${DB_COLS} FROM ${DB_FROM} ${includeUnmanaged ? '' : "WHERE d.status='managed'"} ORDER BY d.name, bs.name`)
        .all();
}

export function get(id) {
    return getDb().prepare(`SELECT ${DB_COLS} FROM ${DB_FROM} WHERE d.id=?`).get(id);
}

/**
 * The catalog row for a name: the log-shipped database (backupOnlyServerId
 * null), or the backups-only one on that server. Managed or not.
 */
export function find(name, backupOnlyServerId = null) {
    return getDb().prepare(`SELECT ${DB_COLS} FROM ${DB_FROM} WHERE d.name=? AND d.backup_only_server_id IS ?`).get(name, backupOnlyServerId);
}

/** "master on sql1" for a backups-only database, else its name. */
export const label = dbLabel;

/**
 * Names that count as managed on a server: every log-shipped database (a name
 * is one database on every server), plus the backups-only ones of that server.
 */
export function namesManagedOn(serverId) {
    return new Set(
        getDb()
            .prepare("SELECT name FROM databases WHERE status='managed' AND (backup_only_server_id IS NULL OR backup_only_server_id=?)")
            .pluck()
            .all(serverId),
    );
}

/** Sets a database's own retention days (null = use the global value). */
export function setRetention(id, { full, diff, log }) {
    getDb()
        .prepare('UPDATE databases SET retention_full_days=?, retention_diff_days=?, retention_log_days=?, updated_at=? WHERE id=?')
        .run(full, diff, log, nowIso(), id);
    return get(id);
}

/**
 * Remembers the database's owner, read from its primary before a backup.
 * Ignored while a restored copy still belongs to Mostly-On's own login, and
 * while the owner is the stand-in a failover fell back to (owner_fallback):
 * the real owner stays remembered, so failing back restores it.
 */
export function noteOwner(id, state) {
    if (!state?.ownerSid || state.ownedByService) return;
    const db = get(id);
    if (!db || db.owner_sid === state.ownerSid) return;
    if (db.owner_fallback && state.ownerName === db.owner_fallback && db.owner_sid) return;
    getDb()
        .prepare('UPDATE databases SET owner_sid=?, owner_name=?, owner_fallback=NULL, updated_at=? WHERE id=?')
        .run(state.ownerSid, state.ownerName ?? null, nowIso(), id);
}

/** After a failover: which login now owns the new primary, and whether it is only a stand-in. */
export function noteRecoveredOwner(id, { ownerName, matchedBy }) {
    getDb()
        .prepare('UPDATE databases SET owner_fallback=?, updated_at=? WHERE id=?')
        .run(matchedBy === 'fallback' ? ownerName : null, nowIso(), id);
}

export function setFamilyGuid(id, familyGuid) {
    getDb().prepare('UPDATE databases SET family_guid=?, updated_at=? WHERE id=?').run(familyGuid, nowIso(), id);
}

const REPLICA_COLS = `r.database_id, r.server_id, s.name AS server_name, r.role, r.chain_state, r.chain_reason,
    r.restore_mode, r.position_lsn, r.position_fork_guid, r.last_restored_file_id,
    r.last_restored_at, r.updated_at, r.restore_delay_minutes, r.restores_paused_until, r.standby_undo_file`;

export function replicas(databaseId) {
    return getDb()
        .prepare(`SELECT ${REPLICA_COLS} FROM database_replicas AS r JOIN servers AS s ON s.id=r.server_id WHERE r.database_id=? ORDER BY r.role, s.name`)
        .all(databaseId);
}

export function primaryOf(databaseId) {
    return getDb()
        .prepare(`SELECT ${REPLICA_COLS} FROM database_replicas AS r JOIN servers AS s ON s.id=r.server_id WHERE r.database_id=? AND r.role='primary'`)
        .get(databaseId);
}

export function replica(databaseId, serverId) {
    return getDb()
        .prepare(`SELECT ${REPLICA_COLS} FROM database_replicas AS r JOIN servers AS s ON s.id=r.server_id WHERE r.database_id=? AND r.server_id=?`)
        .get(databaseId, serverId);
}

/** Every replica on a server, with the database name. */
export function replicasOnServer(serverId) {
    return getDb()
        .prepare(
            `SELECT ${REPLICA_COLS}, d.name AS database_name, d.backup_only_server_id FROM database_replicas AS r
             JOIN servers AS s ON s.id=r.server_id JOIN databases AS d ON d.id=r.database_id
             WHERE r.server_id=? AND d.status='managed' ORDER BY d.name`,
        )
        .all(serverId);
}

/**
 * Adds a server as a secondary in state 'seeding', or puts an existing
 * secondary back into 'seeding' (reseed). Never touches a primary.
 * A reseeded copy keeps its restore delay; any pause ends, and a readable
 * copy will start a new undo file.
 */
export function addSecondary({ databaseId, serverId, restoreMode }) {
    return tx(() => {
        const existing = replica(databaseId, serverId);
        if (existing && existing.role === 'primary') throw new Error('Server is the primary of this database');
        const now = nowIso();
        if (existing) {
            getDb()
                .prepare(
                    `UPDATE database_replicas SET role='secondary', chain_state='seeding', chain_reason=NULL, restore_mode=?,
                        position_lsn=NULL, position_fork_guid=NULL, last_restored_file_id=NULL,
                        last_restored_at=NULL, restores_paused_until=NULL, standby_undo_file=NULL, updated_at=? WHERE database_id=? AND server_id=?`,
                )
                .run(restoreMode, now, databaseId, serverId);
        } else {
            getDb()
                .prepare(
                    `INSERT INTO database_replicas (database_id, server_id, role, chain_state, restore_mode, updated_at)
                     VALUES (?, ?, 'secondary', 'seeding', ?, ?)`,
                )
                .run(databaseId, serverId, restoreMode, now);
        }
        return replica(databaseId, serverId);
    });
}

const REPLICA_PATCHABLE = [
    'chain_state', 'chain_reason', 'restore_mode', 'position_lsn', 'position_fork_guid', 'last_restored_file_id', 'last_restored_at',
    'restore_delay_minutes', 'restores_paused_until', 'standby_undo_file',
];

/** Updates any subset of the replica's shipping fields. */
export function updateReplica(databaseId, serverId, patch) {
    const cols = [];
    const args = { database_id: databaseId, server_id: serverId, now: nowIso() };
    for (const k of REPLICA_PATCHABLE) {
        if (patch[k] !== undefined) {
            cols.push(`${k}=@${k}`);
            args[k] = typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k];
        }
    }
    if (!cols.length) return replica(databaseId, serverId);
    getDb()
        .prepare(`UPDATE database_replicas SET ${cols.join(', ')}, updated_at=@now WHERE database_id=@database_id AND server_id=@server_id`)
        .run(args);
    return replica(databaseId, serverId);
}

/**
 * Failover role change in one transaction: `newPrimaryId` becomes primary,
 * the old primary becomes `oldPrimaryRole` ('secondary' or 'diverged').
 * Neither keeps a restore delay or a pause (a delayed copy never becomes primary).
 */
export function swapPrimary(databaseId, { newPrimaryId, oldPrimaryId, oldPrimaryRole, oldPrimaryPatch = {} }) {
    return tx(() => {
        const now = nowIso();
        // Demote first: the partial unique index allows only one primary.
        getDb()
            .prepare(
                `UPDATE database_replicas SET role=?, chain_state='ok', chain_reason=NULL, restore_mode='norecovery',
                    position_lsn=NULL, position_fork_guid=NULL, last_restored_file_id=NULL, last_restored_at=NULL,
                    restore_delay_minutes=0, restores_paused_until=NULL, standby_undo_file=NULL, updated_at=?
                 WHERE database_id=? AND server_id=?`,
            )
            .run(oldPrimaryRole, now, databaseId, oldPrimaryId);
        if (Object.keys(oldPrimaryPatch).length) updateReplica(databaseId, oldPrimaryId, oldPrimaryPatch);
        getDb()
            .prepare(
                `UPDATE database_replicas SET role='primary', chain_state='ok', chain_reason=NULL, position_lsn=NULL, position_fork_guid=NULL,
                    restore_delay_minutes=0, restores_paused_until=NULL, standby_undo_file=NULL, updated_at=? WHERE database_id=? AND server_id=?`,
            )
            .run(now, databaseId, newPrimaryId);
        return replicas(databaseId);
    });
}

/** Removes a non-primary replica from the catalog (nothing changes on the server). */
export function removeReplica(databaseId, serverId) {
    return getDb().prepare("DELETE FROM database_replicas WHERE database_id=? AND server_id=? AND role!='primary'").run(databaseId, serverId).changes > 0;
}

export const DEFAULT_SCHEDULE_KEYS = Object.freeze([
    ['FULL', 'schedule.default_full'],
    ['DIFF', 'schedule.default_diff'],
    ['LOG', 'schedule.default_log'],
]);

/**
 * Gives a database the default schedules (all of each schedule, also when it
 * was managed before). Only the DIFF default can be off; a stored default
 * without `enabled` is on, as it was before that switch existed.
 * fullOnly: master, which SQL Server only allows FULL backups of.
 */
function defaultSchedules(databaseId, { fullOnly = false } = {}) {
    const now = new Date();
    const ins = getDb().prepare(
        `INSERT INTO schedules (database_id, backup_type, enabled, kind, interval_minutes, at_time, weekday, next_run_at)
         VALUES (@database_id, @backup_type, @enabled, @kind, @interval_minutes, @at_time, @weekday, @next_run_at)
         ON CONFLICT (database_id, backup_type) DO UPDATE SET enabled=excluded.enabled, kind=excluded.kind,
             interval_minutes=excluded.interval_minutes, at_time=excluded.at_time, weekday=excluded.weekday, next_run_at=excluded.next_run_at`,
    );
    for (const [type, key] of fullOnly ? DEFAULT_SCHEDULE_KEYS.slice(0, 1) : DEFAULT_SCHEDULE_KEYS) {
        const d = settings.get(key);
        const enabled = type !== 'DIFF' || d.enabled !== false;
        const sched = { kind: d.kind, interval_minutes: d.interval_minutes ?? null, at_time: d.at_time ?? null, weekday: d.weekday ?? null };
        ins.run({ database_id: databaseId, backup_type: type, enabled: enabled ? 1 : 0, ...sched, next_run_at: enabled ? nextRun(sched, now).toISOString() : null });
    }
    if (fullOnly) getDb().prepare("DELETE FROM schedules WHERE database_id=? AND backup_type!='FULL'").run(databaseId);
}

/**
 * Start managing a database with the given primary. Re-managing a previously
 * unmanaged database keeps its history but resets its replicas.
 * backupOnly: backed up on this server only (system databases, and databases
 * not in FULL recovery); fullOnly: master (a FULL schedule only).
 */
export function manage({ name, familyGuid, primaryServerId, backupOnly = false, fullOnly = false }) {
    return tx(() => {
        const now = nowIso();
        let row = find(name, backupOnly ? primaryServerId : null);
        if (row) {
            getDb().prepare("UPDATE databases SET status='managed', family_guid=?, updated_at=? WHERE id=?").run(familyGuid, now, row.id);
            getDb().prepare('DELETE FROM database_replicas WHERE database_id=?').run(row.id);
        } else {
            const info = getDb()
                .prepare("INSERT INTO databases (name, family_guid, status, created_at, updated_at, backup_only_server_id) VALUES (?, ?, 'managed', ?, ?, ?)")
                .run(name, familyGuid, now, now, backupOnly ? primaryServerId : null);
            row = { id: Number(info.lastInsertRowid) };
        }
        getDb()
            .prepare("INSERT INTO database_replicas (database_id, server_id, role, chain_state, updated_at) VALUES (?, ?, 'primary', 'ok', ?)")
            .run(row.id, primaryServerId, now);
        defaultSchedules(row.id, { fullOnly });
        // A log-shipped name is managed on every server; a backups-only one only on its own.
        if (backupOnly) getDb().prepare('DELETE FROM discovered_databases WHERE name=? AND server_id=?').run(name, primaryServerId);
        else getDb().prepare('DELETE FROM discovered_databases WHERE name=?').run(name);
        return get(row.id);
    });
}

/**
 * Why a database cannot stop being managed (null if it can): every other copy
 * (secondary or out-of-sync) has to be removed first, so no copy is left
 * waiting for log backups that will never come.
 */
export function unmanageBlocker(id) {
    const others = replicas(id).filter((r) => r.role !== 'primary');
    if (!others.length) return null;
    return `Remove its secondaries first (${others.map((r) => r.server_name).join(', ')}: Replicas table on the database page, Remove).`;
}

export function unmanage(id) {
    const blocker = unmanageBlocker(id);
    if (blocker) throw Object.assign(new Error(blocker), { status: 409, expose: true });
    tx(() => {
        getDb().prepare("UPDATE databases SET status='unmanaged', updated_at=? WHERE id=?").run(nowIso(), id);
        getDb().prepare('UPDATE schedules SET enabled=0 WHERE database_id=?').run(id);
        getDb().prepare('DELETE FROM database_replicas WHERE database_id=?').run(id);
    });
}

// --- discovery ---------------------------------------------------------------

/**
 * Replace the discovered set for one server. Returns the names that are new
 * (never seen before and not dismissed).
 */
export function syncDiscovered(serverId, dbs) {
    return tx(() => {
        const now = nowIso();
        const existing = new Map(
            getDb()
                .prepare('SELECT name, dismissed_at FROM discovered_databases WHERE server_id=?')
                .all(serverId)
                .map((r) => [r.name, r]),
        );
        const upsert = getDb().prepare(
            `INSERT INTO discovered_databases (server_id, name, recovery_model, state, has_log_chain, first_seen_at, last_seen_at)
             VALUES (@server_id, @name, @recovery_model, @state, @has_log_chain, @now, @now)
             ON CONFLICT (server_id, name) DO UPDATE SET recovery_model=excluded.recovery_model, state=excluded.state,
                 has_log_chain=excluded.has_log_chain, last_seen_at=excluded.last_seen_at`,
        );
        const added = [];
        for (const d of dbs) {
            upsert.run({ server_id: serverId, name: d.name, recovery_model: d.recoveryModel, state: d.state, has_log_chain: d.lastLogBackupLsn ? 1 : 0, now });
            if (!existing.has(d.name)) added.push(d);
            existing.delete(d.name);
        }
        const del = getDb().prepare('DELETE FROM discovered_databases WHERE server_id=? AND name=?');
        for (const name of existing.keys()) del.run(serverId, name);
        return added;
    });
}

export function discovered({ includeDismissed = false } = {}) {
    return getDb()
        .prepare(
            `SELECT dd.server_id, s.name AS server_name, dd.name, dd.recovery_model, dd.state, dd.has_log_chain,
                    dd.first_seen_at, dd.last_seen_at, dd.dismissed_at
             FROM discovered_databases AS dd JOIN servers AS s ON s.id=dd.server_id
             ${includeDismissed ? '' : 'WHERE dd.dismissed_at IS NULL'}
             ORDER BY dd.name, s.name`,
        )
        .all()
        .map((r) => {
            const manageAs = manageKind({ name: r.name, recoveryModel: r.recovery_model });
            return { ...r, has_log_chain: !!r.has_log_chain, system: isSystemName(r.name), manage_as: manageAs, shippable: manageAs === 'shipped' };
        });
}

export function getDiscovered(serverId, name) {
    return getDb().prepare('SELECT server_id, name, recovery_model, state, has_log_chain, dismissed_at FROM discovered_databases WHERE server_id=? AND name=?').get(serverId, name);
}

// No longer offered by the dashboard (the overview lists every unmanaged
// database); kept so existing API clients keep working.
export function dismissDiscovered(serverId, name, dismissed = true) {
    return getDb()
        .prepare('UPDATE discovered_databases SET dismissed_at=? WHERE server_id=? AND name=?')
        .run(dismissed ? nowIso() : null, serverId, name).changes > 0;
}
