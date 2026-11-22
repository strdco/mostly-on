// Discovery of databases that could be managed, and detection of backups the
// controller did not take ("foreign" backups).
import fs from 'node:fs';
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as foreign from '../store/repos/foreign.js';
import * as ops from '../store/repos/operations.js';
import * as events from '../store/repos/events.js';
import * as inspect from '../sql/inspect.js';
import * as health from './health.js';
import { recordBackupFile } from './backup.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { subscribe, publish } from '../bus.js';
import { log } from '../log.js';

const FOREIGN_SCAN_MS = 60_000;
const LOOKBACK_MS = 3 * 86400_000;
let unsubscribe = null;
let timer = null;
let scanning = false;

/** Updates the list of manageable databases on a server from its latest health check. */
export function syncFromHealth(serverId) {
    const h = health.getHealth(serverId);
    if (!h?.ok) return;
    const managed = new Set(databases.list().map((d) => d.name));
    const candidates = h.databases.filter((d) => d.state === 'ONLINE' && !managed.has(d.name));
    const added = databases.syncDiscovered(serverId, candidates);
    const server = serversRepo.get(serverId);
    for (const d of added) {
        if (d.recoveryModel === 'FULL') {
            events.add('info', 'discovery', `Database ${d.name} on ${server.name} is in FULL recovery and can be managed`, { serverId });
        } else {
            events.add('info', 'discovery', `Database ${d.name} on ${server.name} is in ${d.recoveryModel} recovery and cannot be log shipped`, { serverId });
        }
    }
    if (added.length) publish('discovery.changed', { serverId });
}

/**
 * Compares msdb backup history on a database's primary with the catalog.
 *  - Our own backups missing from the catalog (crash after BACKUP) are imported.
 *  - Non-copy-only backups we did not take are recorded and reported. A
 *    foreign LOG backup breaks the controller's log chain.
 */
export async function scanForeign(db) {
    const primary = databases.primaryOf(db.id);
    if (!primary || !db.family_guid) return;
    const server = serversRepo.get(primary.server_id);
    const since = new Date(Math.max(new Date(db.created_at).getTime(), Date.now() - LOOKBACK_MS));
    const sets = await inspect.backupsetsSince(server.id, db.name, db.family_guid, since);
    let changed = false;

    for (const bs of sets) {
        if (backups.byUuid(bs.backup_set_uuid) || foreign.isKnown(bs.backup_set_uuid)) continue;

        const own = ownBackupClaim(db, server, bs);
        if (own) {
            // Still being recorded by its own operation: leave it alone.
            if (['running', 'queued'].includes(own.op.status)) continue;
            if (tryImportOwn(db, server, bs, own.relPath)) {
                changed = true;
                continue;
            }
        }
        if (bs.is_copy_only) continue; // copy-only backups do not affect the chain

        const isNew = foreign.record({
            uuid: bs.backup_set_uuid,
            databaseId: db.id,
            serverId: server.id,
            type: bs.type,
            finishAt: bs.backup_finish,
            device: bs.devices.join(', '),
        });
        if (!isNew) continue;
        changed = true;
        const where = `${bs.devices.join(', ')} at ${bs.backup_finish}`;
        const refs = { databaseId: db.id, serverId: server.id, data: { uuid: bs.backup_set_uuid, devices: bs.devices, firstLsn: bs.first_lsn, lastLsn: bs.last_lsn } };
        if (bs.type === 'LOG') {
            events.add('error', 'foreign-backup', `A LOG backup of ${db.name} was taken outside Mostly-On, on ${server.name} (${where}). The secondaries never get the changes in it, so shipping stops. Stop the other tool (or make it use COPY_ONLY), then reinitialize the secondaries.`, refs);
            publish('foreign.detected', { databaseId: db.id, type: 'LOG' });
        } else if (bs.type === 'FULL') {
            events.add('warn', 'foreign-backup', `A FULL backup of ${db.name} was taken outside Mostly-On, on ${server.name} (${where}). DIFF backups build on the last FULL, so Mostly-On takes a FULL of its own instead of its next DIFF.`, refs);
        } else {
            events.add('info', 'foreign-backup', `A ${bs.type} backup of ${db.name} was taken outside Mostly-On, on ${server.name} (${where}).`, refs);
        }
    }
    if (changed) publish('database.changed', { databaseId: db.id });
}

/**
 * The operation that took a backup set described as Mostly-On's ("mostly-on
 * op:N"), and the file's path in the catalog; null if the backup is not
 * really Mostly-On's. Anyone who may take a backup can write that
 * description, so it only counts if operation N is about this database and
 * recorded this very file before taking it. Otherwise the backup is foreign.
 */
export function ownBackupClaim(db, server, bs) {
    const opId = Number(/^mostly-on op:(\d+)(?: |$)/.exec(bs.description ?? '')?.[1]);
    if (!opId || bs.devices.length !== 1 || !['FULL', 'DIFF', 'LOG'].includes(bs.type)) return null;
    const op = ops.get(opId);
    if (!op || op.database_id !== db.id) return null;
    let relPath;
    try {
        relPath = translatePath(bs.devices[0], server, pathOpts('sql', 'rel'));
    } catch {
        return null;
    }
    // Every operation saves the path of its backup before taking it (backup: relPath, tail-log: tailRelPath).
    const recorded = [op.ctx?.relPath, op.ctx?.tailRelPath, op.ctx?.safetyRelPath];
    return recorded.includes(relPath) ? { op, relPath } : null;
}

function tryImportOwn(db, server, bs, relPath) {
    if (backups.byRelPath(relPath)) return false;
    const controllerPath = translatePath(relPath, server, pathOpts('rel', 'controller'));
    if (!fs.existsSync(controllerPath)) return false;
    const file = recordBackupFile({ db, server, bs, relPath });
    events.add('warn', 'backup', `Found a ${bs.type} backup Mostly-On took but had not recorded (${relPath}); it is recorded now`, {
        databaseId: db.id,
        serverId: server.id,
        data: { fileId: file.id },
    });
    publish('backup.finished', { databaseId: db.id, serverId: server.id, type: bs.type, fileId: file.id });
    return true;
}

export async function scanAllForeign() {
    if (scanning) return;
    scanning = true;
    try {
        for (const db of databases.list()) {
            const primary = databases.primaryOf(db.id);
            if (!primary || !health.getHealth(primary.server_id)?.ok) continue;
            try {
                await scanForeign(db);
            } catch (err) {
                log.warn('Foreign backup scan failed', { database: db.name, err });
            }
        }
    } finally {
        scanning = false;
    }
}

export function start() {
    unsubscribe = subscribe((evt) => {
        if (evt.type === 'server.health' && evt.payload.ok) {
            try {
                syncFromHealth(evt.payload.serverId);
            } catch (err) {
                log.error('Discovery failed', { err });
            }
        }
    });
    for (const s of serversRepo.list()) syncFromHealth(s.id);
    const loop = async () => {
        await scanAllForeign();
        timer = setTimeout(loop, FOREIGN_SCAN_MS);
        timer.unref?.();
    };
    timer = setTimeout(loop, 5000);
}

export function stop() {
    unsubscribe?.();
    clearTimeout(timer);
}
