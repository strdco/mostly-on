// Backup engine: FULL / DIFF / LOG backups on a database's current primary.
import fs from 'node:fs';
import path from 'node:path';
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as events from '../store/repos/events.js';
import * as inspect from '../sql/inspect.js';
import * as P from '../sql/privileged.js';
import { sqlErrorText } from '../sql/pool.js';
import { backupRelPath, backupRelDir, translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { tryAcquire, BusyError } from './locks.js';
import { createOperation, runOperation } from './operations.js';
import { publish } from '../bus.js';
import { log } from '../log.js';

export const BACKUP_TYPES = ['FULL', 'DIFF', 'LOG'];

function fail(status, message) {
    return Object.assign(new Error(message), { status, expose: true });
}

let chmodWarned = false;

/**
 * mkdir -p for the controller-side directory (SQL Server's BACKUP does not
 * create folders). New folders are made group-writable with setgid, so SQL
 * Server's user can write into them; on shares that ignore modes (SMB/CIFS),
 * the mount options decide instead and the chmod is skipped.
 */
export function ensureDir(server, relDir) {
    const absDir = translatePath(relDir, server, pathOpts('rel', 'controller'));
    let cur = absDir.slice(0, absDir.length - relDir.length).replace(/\/+$/, '') || '/';
    if (!fs.existsSync(cur)) throw new Error(`Backup root ${cur} does not exist on the controller (is the shared volume mounted?)`);
    for (const part of relDir.split('/')) {
        cur = path.posix.join(cur, part);
        if (fs.existsSync(cur)) continue;
        try {
            fs.mkdirSync(cur);
        } catch (err) {
            if (err.code === 'EEXIST') continue; // created meanwhile
            throw new Error(`Mostly-On cannot create the folder ${cur} on the backup share (${err.code || err.message}). Check that the share is mounted read-write for Mostly-On's user (uid ${process.getuid?.() ?? '?'}).`);
        }
        try {
            fs.chmodSync(cur, 0o2770); // umask would otherwise drop group write
        } catch (err) {
            if (!chmodWarned) {
                chmodWarned = true;
                log.warn('Cannot set permissions on new backup folders; the share decides them (mount options)', { folder: cur, err: err.code || err.message });
            }
        }
    }
}

export function uniqueRelPath(db, type, server) {
    const now = new Date();
    for (let i = 1; i < 100; i++) {
        const rel = backupRelPath(db.name, type, now, server.name, i === 1 ? '' : `_${i}`);
        if (backups.byRelPath(rel)) continue;
        if (fs.existsSync(translatePath(rel, server, pathOpts('rel', 'controller')))) continue;
        return rel;
    }
    throw new Error('Could not find a free backup file name');
}

/**
 * Decides which backup to actually take. A LOG needs an established log chain
 * and a FULL in the catalog; a DIFF needs its base FULL in the catalog.
 * Otherwise a FULL is taken instead.
 */
export function effectiveType(requested, state, db) {
    if (requested === 'FULL') return { type: 'FULL', reason: null };
    const latestFull = backups.latestFull(db.id, state.familyGuid);
    if (!latestFull) return { type: 'FULL', reason: `no FULL backup of ${db.name} in the catalog` };
    if (requested === 'LOG') {
        if (!state.lastLogBackupLsn) return { type: 'FULL', reason: 'the database has no log backup chain yet' };
        return { type: 'LOG', reason: null };
    }
    // DIFF
    const base = state.differentialBaseGuid && backups.byUuid(state.differentialBaseGuid);
    if (!base || base.file_status !== 'present' || base.database_id !== db.id) {
        return { type: 'FULL', reason: 'a DIFF builds on the last FULL backup, and that one was not taken by Mostly-On' };
    }
    return { type: 'DIFF', reason: null };
}

/**
 * Validates and starts a backup. Resolves once the operation has been
 * created; `done` settles when the backup has finished (or failed).
 * @returns {Promise<{operation:object, type:string, done:Promise<{operation:object, file:object|null}>}>}
 */
export async function startBackup(databaseId, requestedType, { trigger = 'manual', parentId = null } = {}) {
    if (!BACKUP_TYPES.includes(requestedType)) throw fail(400, `Unknown backup type ${requestedType}`);
    const db = databases.get(databaseId);
    if (!db || db.status !== 'managed') throw fail(404, 'Database is not managed');
    const primary = databases.primaryOf(db.id);
    if (!primary) throw fail(409, `Database ${db.name} has no primary`);
    const server = serversRepo.get(primary.server_id);
    if (!server.enabled) throw fail(409, `Primary server ${server.name} is disabled`);
    P.assertReady(server.id);

    let state;
    try {
        state = await inspect.dbBackupState(server.id, db.name);
    } catch (err) {
        throw fail(503, `Primary ${server.name} is unreachable: ${sqlErrorText(err)}`);
    }
    if (!state) throw fail(409, `Database ${db.name} does not exist on its primary ${server.name}`);
    if (state.state !== 'ONLINE') throw fail(409, `Database ${db.name} is ${state.state} on its primary ${server.name}`);
    if (db.family_guid && state.familyGuid && db.family_guid !== state.familyGuid) {
        throw fail(409, `Database ${db.name} on ${server.name} is not the managed database (family_guid ${state.familyGuid}, expected ${db.family_guid}). Was it dropped and recreated?`);
    }
    if (!db.family_guid && state.familyGuid) databases.setFamilyGuid(db.id, state.familyGuid);
    databases.noteOwner(db.id, state);
    if (state.recoveryModel !== 'FULL' && requestedType !== 'FULL') {
        throw fail(409, `Database ${db.name} is in ${state.recoveryModel} recovery on ${server.name}; log shipping needs FULL`);
    }

    const { type, reason } = effectiveType(requestedType, state, db);
    const release = tryAcquire(db.id, type.toLowerCase());
    if (!release) throw new BusyError(db.id, type.toLowerCase(), []);

    let operation;
    try {
        ensureDir(server, backupRelDir(db.name, type));
        const relPath = uniqueRelPath(db, type, server);
        const sqlPath = translatePath(relPath, server, pathOpts('rel', 'sql'));
        const stepDefs = backupSteps({ db, server, type, relPath, sqlPath });
        operation = createOperation({
            type: 'backup',
            databaseId: db.id,
            serverId: server.id,
            parentId,
            params: { type, requestedType, trigger, reason },
            ctx: { relPath },
            stepDefs,
        });
        if (reason) {
            events.add('info', 'backup', `Taking a FULL backup of ${db.name} instead of ${requestedType}: ${reason}`, { databaseId: db.id, serverId: server.id, operationId: operation.id });
        }
        const done = runOperation(operation.id, stepDefs)
            .then((op) => {
                const file = op.ctx.fileId ? backups.get(op.ctx.fileId) : null;
                if (op.status === 'succeeded' && file) {
                    if (type !== 'LOG' || trigger !== 'schedule') {
                        events.add('info', 'backup', `${type} backup of ${db.name} on ${server.name} finished`, {
                            databaseId: db.id,
                            serverId: server.id,
                            operationId: op.id,
                            data: { file: file.rel_path, sizeBytes: file.size_bytes },
                        });
                    }
                    publish('backup.finished', { databaseId: db.id, serverId: server.id, type, fileId: file.id });
                } else {
                    publish('backup.failed', { databaseId: db.id, serverId: server.id, type, operationId: op.id, error: op.error });
                }
                return { operation: op, file };
            })
            .finally(release);
        return { operation, type, done };
    } catch (err) {
        release();
        throw err;
    }
}

function backupSteps({ db, server, type, relPath, sqlPath }) {
    return [
        {
            name: 'backup',
            label: `${type} backup on ${server.name}`,
            // After a crash: the backup may have completed even though the step did not finish.
            check: async () => ((await inspect.backupsetByPath(server.id, db.name, sqlPath)) ? 'SQL Server already has this backup on record' : false),
            run: async (ctx) => {
                await P.run(
                    server.id,
                    P.takeBackup({ db: db.name, type, path: sqlPath, name: `Mostly-On ${type}`, description: `mostly-on op:${ctx.op.id}` }),
                    { timeoutMs: 0, onInfo: (m) => ctx.progress(m) },
                );
                return sqlPath;
            },
        },
        {
            name: 'catalog',
            label: 'Record the backup',
            check: async (ctx) => {
                const f = backups.byRelPath(relPath);
                if (!f) return false;
                ctx.save({ fileId: f.id });
                return `Already recorded as #${f.id}`;
            },
            run: async (ctx) => {
                const bs = await inspect.backupsetByPath(server.id, db.name, sqlPath);
                if (!bs) throw new Error(`Backup of ${db.name} to ${sqlPath} is not in msdb on ${server.name}`);
                const file = recordBackupFile({ db, server, bs, relPath, operationId: ctx.op.id });
                ctx.save({ fileId: file.id });
                return `#${file.id} ${relPath} (${file.size_bytes ?? '?'} bytes)`;
            },
        },
    ];
}

/**
 * Inserts a backup set into the catalog and checks that the controller can
 * see the file (a wrong path mapping would silently break shipping and retention).
 */
export function recordBackupFile({ db, server, bs, relPath, operationId = null, isTail = false, type = null }) {
    let size = bs.size_bytes;
    const controllerPath = translatePath(relPath, server, pathOpts('rel', 'controller'));
    try {
        size = fs.statSync(controllerPath).size;
    } catch {
        events.add(
            'error',
            'backup',
            `The controller cannot see backup file ${controllerPath} written by ${server.name}. Check the backup path mapping of ${server.name}: its SQL path and the controller path must be the same shared volume.`,
            { databaseId: db.id, serverId: server.id, operationId },
        );
    }
    return backups.insert({
        database_id: db.id,
        server_id: server.id,
        type: type || bs.type,
        rel_path: relPath,
        first_lsn: bs.first_lsn,
        last_lsn: bs.last_lsn,
        checkpoint_lsn: bs.checkpoint_lsn,
        database_backup_lsn: bs.database_backup_lsn,
        differential_base_lsn: bs.differential_base_lsn,
        differential_base_guid: bs.differential_base_guid,
        family_guid: bs.family_guid,
        recovery_fork_guid: bs.recovery_fork_guid,
        first_recovery_fork_guid: bs.first_recovery_fork_guid,
        fork_point_lsn: bs.fork_point_lsn,
        backup_set_uuid: bs.backup_set_uuid,
        backup_start: bs.backup_start,
        backup_finish: bs.backup_finish,
        size_bytes: size,
        has_checksum: bs.has_checksum,
        is_copy_only: bs.is_copy_only,
        is_tail: isTail ? 1 : 0,
        operation_id: operationId,
    });
}
