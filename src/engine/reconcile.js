// Startup reconciliation: bring the journal in line with what actually
// happened on the servers while the controller was down or crashed.
//
// SQL Server is the source of truth for state; the catalog for intent.
import * as ops from '../store/repos/operations.js';
import * as backups from '../store/repos/backups.js';
import * as restores from '../store/repos/restores.js';
import * as forks from '../store/repos/forks.js';
import * as health from './health.js';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_TYPES, backupRelDir } from '../paths.js';
import { engineConfig } from './context.js';
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
    // A restore cut off by the stop either completed on the server or not; the
    // restore loop reads the real position from SQL Server before it continues.
    const cut = restores.markInterrupted();
    if (cut) events.add('info', 'restore', `${cut} restore(s) were running when the controller stopped; the restore loops re-check the secondaries' positions`);

    for (const op of ops.unfinished()) {
        try {
            if (op.type === 'backup') {
                await reconcileBackup(op);
            } else {
                // Multi-step operations (seed, failover ...) are never resumed
                // automatically; a user resumes or resolves them from the UI.
                finish(op, 'interrupted', `Controller restarted during step "${op.current_step}". Check the servers, then resume or mark resolved.`);
                if ((op.type === 'seed' || op.type === 'reseed') && op.params.targetServerId) {
                    const rep = databases.replica(op.database_id, op.params.targetServerId);
                    if (rep?.chain_state === 'seeding') {
                        databases.updateReplica(op.database_id, op.params.targetServerId, { chain_reason: `Adding this secondary (operation #${op.id}) was interrupted by a Mostly-On restart; resume it from Operations` });
                    }
                }
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

    for (const db of databases.list()) {
        try {
            ensureRootFork(db);
            reportDrift(db);
        } catch (err) {
            events.add('error', 'controller', `Could not check ${db.name} against the servers: ${err.message}`, { databaseId: db.id });
        }
    }
    try {
        reportOrphans();
    } catch (err) {
        events.add('warn', 'controller', `Could not scan the backup volume for orphan files: ${err.message}`);
    }
}

/** Databases managed before forks were tracked get their primary's current fork as root. */
function ensureRootFork(db) {
    const primary = databases.primaryOf(db.id);
    const live = primary ? health.dbState(primary.server_id, db.name) : null;
    if (live?.recoveryForkGuid && forks.ensureRoot(db.id, live.recoveryForkGuid)) {
        events.add('info', 'controller', `Recorded recovery fork ${live.recoveryForkGuid} of ${db.name} as its root fork`, { databaseId: db.id });
    }
}

/**
 * Intent (catalog) against state (SQL Server): the primary must be ONLINE,
 * secondaries RESTORING or STANDBY, diverged copies should not be writable.
 * Nothing is changed; differences are reported.
 */
function reportDrift(db) {
    for (const r of databases.replicas(db.id)) {
        const h = health.getHealth(r.server_id);
        if (!h?.ok) {
            events.add('warn', 'controller', `Cannot check ${db.name} on ${r.server_name} at startup: the server is unreachable`, { databaseId: db.id, serverId: r.server_id });
            continue;
        }
        const live = health.dbState(r.server_id, db.name);
        const state = live ? (live.isInStandby ? 'STANDBY' : live.state) : 'missing';
        let problem = null;
        if (r.role === 'primary' && state !== 'ONLINE') problem = `is the primary in the catalog but ${state} on the server`;
        if (r.role === 'secondary' && r.chain_state !== 'seeding' && !['RESTORING', 'STANDBY'].includes(state)) problem = `is a secondary in the catalog but ${state} on the server`;
        if (r.role === 'diverged' && state === 'ONLINE') problem = 'holds a diverged copy that is ONLINE and writable (split-brain risk)';
        if (problem) events.add('error', 'controller', `At startup: ${db.name} on ${r.server_name} ${problem}`, { databaseId: db.id, serverId: r.server_id, data: { role: r.role, state } });
    }
}

/** Backup files under a managed database's folders that the catalog does not know. Never deleted. */
function reportOrphans() {
    const root = engineConfig().backupRoot;
    for (const db of databases.list()) {
        const known = new Set(backups.all(db.id).map((f) => f.rel_path));
        const orphans = [];
        for (const type of Object.keys(BACKUP_TYPES)) {
            const relDir = backupRelDir(db.name, type);
            let names = [];
            try {
                names = fs.readdirSync(path.join(root, relDir));
            } catch {
                continue;
            }
            for (const n of names) if (!known.has(`${relDir}/${n}`)) orphans.push(`${relDir}/${n}`);
        }
        if (orphans.length) {
            events.add('warn', 'controller', `${orphans.length} file(s) in the backup folders of ${db.name} were not made by Mostly-On, or it has no record of them. They are left alone; delete them by hand if they are not needed.`, {
                databaseId: db.id,
                data: { files: orphans.slice(0, 50) },
            });
        }
    }
}
