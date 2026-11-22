// Restore primitives shared by the restore loop, seeding and (later) failovers.
import fs from 'node:fs';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as restores from '../store/repos/restores.js';
import * as P from '../sql/privileged.js';
import * as inspect from '../sql/inspect.js';
import { sqlErrorText } from '../sql/pool.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { undoFilePath, classifyRestoreError } from './restore-plan.js';
import { publish } from '../bus.js';

/**
 * Checks that a cataloged backup file is on the shared volume (as the
 * controller sees it) and keeps file_status in line with what is found.
 */
export function fileOnDisk(file) {
    const exists = existsOnShare(file);
    if (exists && file.file_status === 'missing') backups.markStatus(file.id, 'present');
    if (!exists && file.file_status === 'present') backups.markStatus(file.id, 'missing');
    return exists;
}

function existsOnShare(file) {
    const writer = serversRepo.get(file.server_id);
    return fs.existsSync(translatePath(file.rel_path, writer, pathOpts('rel', 'controller')));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Like fileOnDisk(), for decisions that stop shipping or an operation: a file
 * that seems absent is checked again for a few seconds before it counts as
 * missing. A network share (SMB/CIFS) can keep reporting "no such file" for a
 * moment after another machine (the SQL Server that took the backup) created it,
 * because the client caches the earlier negative lookup.
 */
export async function confirmOnDisk(file, { attempts = 6, delayMs = 1000 } = {}) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(delayMs);
        if (existsOnShare(file)) {
            if (file.file_status === 'missing') backups.markStatus(file.id, 'present');
            return true;
        }
    }
    if (file.file_status === 'present') backups.markStatus(file.id, 'missing');
    return false;
}

/**
 * Why a file whose RESTORE HEADERONLY gave `headers` is not the backup the
 * catalog recorded for it, or null if it is. RESTORE uses the first backup set
 * in a file, and its GUID must be the one msdb gave that backup.
 */
export function wrongBackupReason(file, headers) {
    const expected = inspect.guid(file.backup_set_uuid);
    if (!expected) return null;
    const found = headers.find((h) => h.position === 1)?.backupSetGuid ?? null;
    if (found === expected) return null;
    return `${file.rel_path} no longer holds the backup Mostly-On took (backup set ${expected}; the file now holds ${found ?? 'no backup'}). Something replaced the file after the backup was taken. Put the original file back.`;
}

/**
 * Throws (err.restoreKind 'wrong_file') unless the file still holds the backup
 * the catalog recorded. Backup file names are predictable, and anyone allowed
 * to back up a database on a server that writes to the share could overwrite
 * one; restoring it would quietly restore something else.
 */
export async function assertSameBackup(server, file, sqlPath = translatePath(file.rel_path, server, pathOpts('rel', 'sql'))) {
    if (!file.backup_set_uuid) return;
    const reason = wrongBackupReason(file, await inspect.headerOnly(server.id, sqlPath));
    if (reason) throw Object.assign(new Error(reason), { restoreKind: 'wrong_file' });
}

/**
 * Runs one RESTORE of a cataloged backup file on `server` and records it in
 * the restores table. FULL and DIFF are always restored WITH NORECOVERY; a
 * LOG WITH NORECOVERY or STANDBY depending on `mode`.
 *
 * Throws on failure, after recording it; err.restoreKind is the
 * classifyRestoreError() result.
 *
 * @param {{db:object, server:object, file:object, operationId?:number|null, mode?:'norecovery'|'standby',
 *          undo?:string|null, moves?:{from:string,to:string}[], replace?:boolean, onInfo?:(m:string)=>void}} p
 *   undo: the STANDBY undo file (restore-plan.js standbyUndoFile(); the restore loop picks it).
 *   priority, abortWhen, onWait: how it waits for a free connection on the server
 *   (privileged.js run()); one that gave way while waiting throws with
 *   restoreKind 'gave_way' (nothing was restored).
 */
export async function restoreFile({ db, server, file, operationId = null, mode = 'norecovery', undo = null, moves = [], replace = false, onInfo, priority = false, abortWhen = null, onWait = null }) {
    const sqlPath = translatePath(file.rel_path, server, pathOpts('rel', 'sql'));
    let c;
    if (file.type === 'LOG') {
        c = P.restoreLog({ db: db.name, path: sqlPath, undo: mode === 'standby' ? (undo ?? undoFilePath(server, db.name)) : null });
    } else if (file.type === 'FULL' || file.type === 'DIFF') {
        c = P.restoreDatabase({ db: db.name, path: sqlPath, moves, replace });
    } else {
        throw new Error(`Cannot ship a ${file.type} backup`);
    }

    const restoreId = restores.start({ backupFileId: file.id, databaseId: db.id, serverId: server.id, operationId });
    try {
        await assertSameBackup(server, file, sqlPath);
        await P.run(server.id, c, { timeoutMs: 0, onInfo, onWait, priority, abortWhen });
    } catch (err) {
        const kind = err.restoreKind ?? (err.gaveWay ? 'gave_way' : classifyRestoreError(err));
        // "In use": someone reconnected between the disconnect and the restore. "Gave way": it never
        // started (a failover or rollback needed the database). Either way nothing was restored.
        if (kind === 'in_use' || kind === 'gave_way') restores.discard(restoreId);
        else restores.finish(restoreId, kind === 'already_applied' ? 'already_applied' : 'failed', sqlErrorText(err));
        err.restoreKind = kind;
        throw err;
    }
    restores.finish(restoreId, 'success');
    publish('restore.finished', { databaseId: db.id, serverId: server.id, fileId: file.id, type: file.type });
    return restoreId;
}
