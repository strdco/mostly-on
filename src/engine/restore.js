// Restore primitives shared by the restore loop, seeding and (later) failovers.
import fs from 'node:fs';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as restores from '../store/repos/restores.js';
import * as Q from '../sql/tsql.js';
import { query, T, sqlErrorText } from '../sql/pool.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { undoFilePath, classifyRestoreError } from './restore-plan.js';
import { publish } from '../bus.js';

/**
 * Checks that a cataloged backup file is on the shared volume (as the
 * controller sees it) and keeps file_status in line with what is found.
 */
export function fileOnDisk(file) {
    const writer = serversRepo.get(file.server_id);
    const p = translatePath(file.rel_path, writer, pathOpts('rel', 'controller'));
    const exists = fs.existsSync(p);
    if (exists && file.file_status === 'missing') backups.markStatus(file.id, 'present');
    if (!exists && file.file_status === 'present') backups.markStatus(file.id, 'missing');
    return exists;
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
 *          moves?:{from:string,to:string}[], replace?:boolean, onInfo?:(m:string)=>void}} p
 */
export async function restoreFile({ db, server, file, operationId = null, mode = 'norecovery', moves = [], replace = false, onInfo }) {
    const sqlPath = translatePath(file.rel_path, server, pathOpts('rel', 'sql'));
    const params = { db: T.sysname(db.name), path: T.nvarchar(sqlPath) };
    let text;
    if (file.type === 'LOG') {
        const standby = mode === 'standby';
        text = Q.restoreLog({ standby });
        if (standby) params.undo = T.nvarchar(undoFilePath(server, db.name));
    } else if (file.type === 'FULL' || file.type === 'DIFF') {
        text = Q.restoreDatabase({ moveCount: moves.length, replace });
        moves.forEach((m, i) => {
            params[`move_from${i}`] = T.sysname(m.from);
            params[`move_to${i}`] = T.nvarchar(m.to);
        });
    } else {
        throw new Error(`Cannot ship a ${file.type} backup`);
    }

    const restoreId = restores.start({ backupFileId: file.id, databaseId: db.id, serverId: server.id, operationId });
    try {
        await query(server.id, text, params, { timeoutMs: 0, onInfo });
    } catch (err) {
        const kind = classifyRestoreError(err);
        // "In use": someone reconnected between the disconnect and the restore. Nothing was restored.
        if (kind === 'in_use') restores.discard(restoreId);
        else restores.finish(restoreId, kind === 'already_applied' ? 'already_applied' : 'failed', sqlErrorText(err));
        err.restoreKind = kind;
        throw err;
    }
    restores.finish(restoreId, 'success');
    publish('restore.finished', { databaseId: db.id, serverId: server.id, fileId: file.id, type: file.type });
    return restoreId;
}
