// Backups-only databases, and which backup types a database may take right
// now. Pure: no I/O, so the rules are easy to test.
//
// A backups-only database is backed up on its own server and never shipped,
// failed over or restored by Mostly-On: the system databases master, model and
// msdb, and user databases that were not in FULL recovery when they started
// being managed. Each belongs to one server (every server has its own master).

export const SYSTEM_DATABASE_IDS = Object.freeze([1, 3, 4]); // master, model, msdb; 2 (tempdb) is never backed up
export const SYSTEM_DATABASE_NAMES = Object.freeze(['master', 'model', 'msdb']);
export const MASTER_ID = 1;

export const isBackupOnly = (db) => db?.backup_only_server_id != null;

// Mostly-On's own rule, in words. (SQL Server itself allows DIFF backups in
// SIMPLE recovery, and DIFF and LOG backups in BULK_LOGGED; only master is
// FULL only, whatever its recovery model.)
export const ONLY_FULL_MASTER = 'Mostly-On takes only full backups of master, and of databases in SIMPLE or BULK_LOGGED recovery.';
const ONLY_FULL_NON_FULL = 'Mostly-On takes only full backups of databases in SIMPLE or BULK_LOGGED recovery';

/** A system database by name, for lists that only have names (discovery). */
export const isSystemName = (name) => SYSTEM_DATABASE_NAMES.includes(String(name ?? '').toLowerCase());

/** "master on sql1" for a backups-only database, else its name. Needs backup_only_server_name. */
export function dbLabel(db) {
    if (!db) return '';
    return isBackupOnly(db) ? `${db.name} on ${db.backup_only_server_name ?? `server ${db.backup_only_server_id}`}` : db.name;
}

/**
 * How a database would be managed: 'backup_only' for a system database or one
 * not in FULL recovery, else 'shipped'. Prefer `databaseId` (as the server
 * reports it); `name` is the fallback for lists that only have names.
 */
export function manageKind({ databaseId = null, name = null, recoveryModel }) {
    const system = databaseId != null ? SYSTEM_DATABASE_IDS.includes(databaseId) : isSystemName(name);
    return system || recoveryModel !== 'FULL' ? 'backup_only' : 'shipped';
}

/**
 * Why a backup of `type` cannot be taken now, or null if it can.
 *   live: { recoveryModel, databaseId } as the server reports them now (either may be unknown)
 * Returns { skip, status, message }. skip=true means the type does not apply
 * right now (a backups-only database not in FULL recovery, or master): a
 * schedule moves on quietly, with `status` as its last status. skip=false is a
 * real problem (a log-shipped database that left FULL recovery).
 */
export function backupTypeProblem(db, live, type, serverName) {
    if (type === 'FULL') return null;
    const { recoveryModel = null, databaseId = null } = live ?? {};
    if (isBackupOnly(db)) {
        if (databaseId === MASTER_ID || (databaseId == null && db.name === 'master')) {
            return { skip: true, status: 'skipped: master is FULL only', message: ONLY_FULL_MASTER };
        }
        if (recoveryModel && recoveryModel !== 'FULL') {
            return {
                skip: true,
                status: `skipped: ${recoveryModel} recovery`,
                message: `${ONLY_FULL_NON_FULL}, and ${db.name} on ${serverName} is in ${recoveryModel} recovery. Its DIFF and LOG backups start by themselves when it is switched to FULL recovery.`,
            };
        }
        return null;
    }
    if (recoveryModel && recoveryModel !== 'FULL') {
        return { skip: false, message: `Database ${db.name} is in ${recoveryModel} recovery on ${serverName}; log shipping needs FULL` };
    }
    return null;
}

/** The types that do not apply right now: { DIFF: reason, LOG: reason } (only the ones that are skipped). */
export function skippedTypes(db, live, serverName) {
    const out = {};
    for (const type of ['DIFF', 'LOG']) {
        const p = backupTypeProblem(db, live, type, serverName);
        if (p?.skip) out[type] = p.message;
    }
    return out;
}
