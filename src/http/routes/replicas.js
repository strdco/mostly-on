// Secondaries: seeding, shipping settings, restore history.
import { HttpError, idParam } from '../router.js';
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as backups from '../../store/repos/backups.js';
import * as restores from '../../store/repos/restores.js';
import * as events from '../../store/repos/events.js';
import * as health from '../../engine/health.js';
import { seedPreflight, startSeed, RESTORE_MODES } from '../../engine/ops/seed.js';
import { nudge } from '../../engine/restore-loop.js';
import { fileOnDisk } from '../../engine/restore.js';
import { undoFilePath } from '../../engine/restore-plan.js';
import { holders } from '../../engine/locks.js';
import { restoreCompatibility } from '../../sqlversion.js';
import { publish } from '../../bus.js';

function mustGetDb(id) {
    const db = databases.get(id);
    if (!db || db.status !== 'managed') throw new HttpError(404, 'Database not found or not managed');
    return db;
}

function mustGetSecondary(db, serverId) {
    const rep = databases.replica(db.id, serverId);
    if (!rep) throw new HttpError(404, 'That server holds no replica of this database');
    if (rep.role === 'primary') throw new HttpError(409, `${rep.server_name} is the primary of ${db.name}`);
    return rep;
}

function changed(db, serverId) {
    publish('replica.changed', { databaseId: db.id, serverId });
}

export function replicaRoutes(router) {
    // What a seed onto this server would involve (UI calls it when a target is picked).
    router.get('/api/databases/:id/seed-preflight', async (ctx) => {
        const pf = await seedPreflight(idParam(ctx.params.id), idParam(ctx.query.server_id, 'server_id'));
        return {
            server: { id: pf.target.id, name: pf.target.name },
            primary: { id: pf.primaryServer.id, name: pf.primaryServer.name },
            replica: pf.replica ? { role: pf.replica.role, chain_state: pf.replica.chain_state } : null,
            compat: pf.compat,
            existsOnTarget: pf.existsOnTarget,
            standbyPath: pf.standbyPath,
            dataPath: pf.dataPath,
            logPath: pf.logPath,
        };
    });

    router.post('/api/databases/:id/secondaries', async (ctx) => {
        const b = ctx.body || {};
        const started = await startSeed(idParam(ctx.params.id), {
            serverId: idParam(b.server_id, 'server_id'),
            source: b.source,
            restoreMode: b.restore_mode,
            overwrite: b.overwrite === true,
            confirm: typeof b.confirm === 'string' ? b.confirm : null,
        });
        ctx.status = 202;
        return { operation: started.operation };
    });

    // Shipping settings of a secondary; they apply from the next restore.
    router.put('/api/databases/:id/replicas/:serverId', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        const b = ctx.body || {};
        const patch = {};
        if (b.restore_mode !== undefined) {
            if (!RESTORE_MODES.includes(b.restore_mode)) throw new HttpError(400, `restore_mode must be one of ${RESTORE_MODES.join(', ')}`);
            if (b.restore_mode === 'standby') {
                const primary = databases.primaryOf(db.id);
                const compat = restoreCompatibility(health.getHealth(primary?.server_id)?.info?.majorVersion, health.getHealth(rep.server_id)?.info?.majorVersion);
                if (!compat.standby) throw new HttpError(409, `STANDBY needs the same SQL Server version on primary and secondary. ${compat.reason || ''}`.trim());
                try {
                    undoFilePath(serversRepo.get(rep.server_id), db.name);
                } catch (err) {
                    throw new HttpError(409, err.message);
                }
            }
            patch.restore_mode = b.restore_mode;
        }
        const updated = databases.updateReplica(db.id, rep.server_id, patch);
        events.add('info', 'restore', `Shipping settings of ${db.name} on ${rep.server_name} changed`, { databaseId: db.id, serverId: rep.server_id, data: patch });
        changed(db, rep.server_id);
        return updated;
    });

    // After fixing the cause of a broken chain (e.g. putting a missing file
    // back), let the restore loop try again. It stops again if nothing changed.
    router.post('/api/databases/:id/replicas/:serverId/recheck', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        if (!['broken', 'needs_reseed'].includes(rep.chain_state)) throw new HttpError(409, `Shipping to ${rep.server_name} is ${rep.chain_state}, not broken`);
        let found = 0;
        for (const f of backups.all(db.id)) {
            if (f.file_status === 'missing' && fileOnDisk(f)) found++;
        }
        databases.updateReplica(db.id, rep.server_id, { chain_state: 'ok', chain_reason: null });
        events.add('info', 'restore', `Rechecking log shipping of ${db.name} to ${rep.server_name}${found ? ` (${found} missing file(s) are back on disk)` : ''}`, {
            databaseId: db.id,
            serverId: rep.server_id,
            data: { previous: rep.chain_state, reason: rep.chain_reason },
        });
        changed(db, rep.server_id);
        nudge(db.id, rep.server_id, { force: true });
        return { ok: true, filesFound: found };
    });

    // Stop shipping to a secondary. The copy on the server is left untouched.
    router.post('/api/databases/:id/replicas/:serverId/remove', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        if (ctx.body?.confirm !== db.name) throw new HttpError(400, 'Type the database name to confirm');
        const busy = holders(db.id).filter((k) => k === 'exclusive' || k === `restore:${rep.server_id}`);
        if (busy.length) throw new HttpError(409, `${rep.server_name} is busy (${busy.join(', ')}); try again when it has finished`);
        databases.removeReplica(db.id, rep.server_id);
        events.add('warn', 'restore', `${rep.server_name} is no longer a ${rep.role} of ${db.name}. The database on ${rep.server_name} is left as it is.`, {
            databaseId: db.id,
            serverId: rep.server_id,
        });
        changed(db, rep.server_id);
        publish('database.changed', { databaseId: db.id });
        return { ok: true };
    });

    router.get('/api/databases/:id/restores', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        return restores.list({
            databaseId: db.id,
            serverId: ctx.query.server_id ? idParam(ctx.query.server_id, 'server_id') : undefined,
            limit: Number(ctx.query.limit) || 100,
        });
    });
}
