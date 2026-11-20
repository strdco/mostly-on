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

        if (bs.description?.startsWith('cheap-log') && bs.devices.length === 1 && ['FULL', 'DIFF', 'LOG'].includes(bs.type)) {
            // Still being recorded by its own operation: leave it alone.
            const opId = Number(/op:(\d+)/.exec(bs.description)?.[1]);
            if (opId && ['running', 'queued'].includes(ops.get(opId)?.status)) continue;
            const imported = tryImportOwn(db, server, bs);
            if (imported) {
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
            events.add('error', 'foreign-backup', `Foreign LOG backup of ${db.name} on ${server.name} (${where}). The log chain is broken from cheap-log's point of view: secondaries cannot restore past it.`, refs);
            publish('foreign.detected', { databaseId: db.id, type: 'LOG' });
        } else if (bs.type === 'FULL') {
            events.add('warn', 'foreign-backup', `Foreign FULL backup of ${db.name} on ${server.name} (${where}). It changes the differential base, so cheap-log takes a FULL instead of its next DIFF.`, refs);
        } else {
            events.add('info', 'foreign-backup', `Foreign ${bs.type} backup of ${db.name} on ${server.name} (${where}).`, refs);
        }
    }
    if (changed) publish('database.changed', { databaseId: db.id });
}

function tryImportOwn(db, server, bs) {
    let relPath;
    try {
        relPath = translatePath(bs.devices[0], server, pathOpts('sql', 'rel'));
    } catch {
        return false;
    }
    if (backups.byRelPath(relPath)) return false;
    const controllerPath = translatePath(relPath, server, pathOpts('rel', 'controller'));
    if (!fs.existsSync(controllerPath)) return false;
    const file = recordBackupFile({ db, server, bs, relPath });
    events.add('warn', 'backup', `Recovered catalog entry for ${bs.type} backup ${relPath} (taken by cheap-log, found in msdb but missing from the catalog)`, {
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
