// Startup reconciliation: bring the journal in line with what actually
// happened on the servers while the controller was down or crashed.
//
// SQL Server is the source of truth for state; the catalog for intent.
import * as ops from '../store/repos/operations.js';
import * as backups from '../store/repos/backups.js';
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as events from '../store/repos/events.js';
import * as inspect from '../sql/inspect.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { recordBackupFile } from './backup.js';
import { nowIso } from '../store/db.js';
import { sqlErrorText } from '../sql/pool.js';

function finish(op, status, message) {
    const steps = op.steps.map((s) => {
        if (status === 'succeeded') return s.status === 'skipped' ? s : { ...s, status: 'done' };
        return s.status === 'running' ? { ...s, status: 'interrupted' } : s;
    });
    ops.save(op.id, { status, steps, error: status === 'succeeded' ? null : message, finished_at: nowIso(), current_step: status === 'succeeded' ? null : op.current_step });
}

/** A backup operation that was running when the controller stopped. */
async function reconcileBackup(op) {
    const db = databases.get(op.database_id);
    const server = serversRepo.get(op.server_id);
    const relPath = op.ctx.relPath;
    if (!db || !server || !relPath) {
        finish(op, 'interrupted', 'Controller restarted during the backup; not enough information to check the outcome');
        return;
    }
    const existing = backups.byRelPath(relPath);
    if (existing) {
        ops.save(op.id, { ctx: { ...op.ctx, fileId: existing.id } });
        finish(op, 'succeeded');
        return;
    }
    let bs;
    try {
        bs = await inspect.backupsetByPath(server.id, db.name, translatePath(relPath, server, pathOpts('rel', 'sql')));
    } catch (err) {
        // The periodic foreign-backup scan imports it later via its msdb description.
        finish(op, 'interrupted', `Controller restarted during the backup and ${server.name} is unreachable (${sqlErrorText(err)}). If the backup completed it will be imported when the server is reachable.`);
        events.add('warn', 'backup', `Backup operation #${op.id} of ${db.name} was interrupted by a controller restart; outcome unknown until ${server.name} is reachable`, { databaseId: db.id, serverId: server.id, operationId: op.id });
        return;
    }
    if (bs) {
        const file = recordBackupFile({ db, server, bs, relPath, operationId: op.id });
        ops.save(op.id, { ctx: { ...op.ctx, fileId: file.id } });
        finish(op, 'succeeded');
        events.add('info', 'backup', `Backup operation #${op.id} of ${db.name} completed while the controller was down; recorded ${relPath}`, { databaseId: db.id, serverId: server.id, operationId: op.id });
    } else {
        finish(op, 'interrupted', 'Controller restarted before the backup completed. Any partial file is left in place for inspection.');
        events.add('warn', 'backup', `Backup operation #${op.id} of ${db.name} was interrupted by a controller restart and did not complete (file ${relPath} may be partial and is not used)`, { databaseId: db.id, serverId: server.id, operationId: op.id });
    }
}

export async function reconcileOnStartup() {
    for (const op of ops.unfinished()) {
        try {
            if (op.type === 'backup') {
                await reconcileBackup(op);
            } else {
                // Multi-step operations (seed, failover ...) are never resumed
                // automatically; a user resumes or resolves them from the UI.
                finish(op, 'interrupted', `Controller restarted during step "${op.current_step}". Check the servers, then resume or mark resolved.`);
                events.add('error', op.type, `Operation #${op.id} (${op.type}) was interrupted by a controller restart during step "${op.current_step}"`, {
                    databaseId: op.database_id,
                    serverId: op.server_id,
                    operationId: op.id,
                });
            }
        } catch (err) {
            events.add('error', 'controller', `Could not reconcile operation #${op.id}: ${err.message}`, { operationId: op.id });
        }
    }
}
