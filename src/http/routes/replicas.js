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
import { undoFilePath, isPaused, MAX_RESTORE_DELAY_MINUTES, MAX_PAUSE_HOURS } from '../../engine/restore-plan.js';
import { restoreDelayChangeBlocker, delayText } from '../../engine/ops/shared.js';
import { nowIso } from '../../store/db.js';
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
        // Restore delay: keeps the copy behind on purpose, so it is never a failover target.
        const before = rep.restore_delay_minutes;
        let delay = before;
        if (b.restore_delay_minutes !== undefined) {
            delay = b.restore_delay_minutes === null || b.restore_delay_minutes === '' ? 0 : Number(b.restore_delay_minutes);
            if (!Number.isInteger(delay) || delay < 0 || delay > MAX_RESTORE_DELAY_MINUTES) {
                throw new HttpError(400, `The restore delay must be a whole number of minutes from 0 to ${MAX_RESTORE_DELAY_MINUTES} (7 days)`);
            }
        }
        if (delay !== before) {
            if (delay > 0) {
                if (rep.role !== 'secondary') throw new HttpError(409, `Only a working secondary can be kept behind; ${rep.server_name} holds an out-of-sync copy`);
                const blocker = restoreDelayChangeBlocker(db, rep); // checked and saved with no await in between
                if (blocker) throw new HttpError(409, blocker);
            }
            patch.restore_delay_minutes = delay;
            // Lowered: the copy catches up now, without lag alerts until it is back where its delay says.
            // Removed: a pause ends with it. A pause still running under a smaller delay stays.
            if (delay < before && (delay === 0 || !isPaused(rep))) patch.restores_paused_until = nowIso();
        }
        const updated = databases.updateReplica(db.id, rep.server_id, patch);
        if (patch.restore_mode !== undefined) {
            events.add('info', 'restore', `Shipping settings of ${db.name} on ${rep.server_name} changed`, { databaseId: db.id, serverId: rep.server_id, data: { restore_mode: patch.restore_mode } });
        }
        if (delay !== before) {
            const refs = { databaseId: db.id, serverId: rep.server_id, data: { restore_delay_minutes: delay, before } };
            if (before === 0) events.add('warn', 'restore', `${rep.server_name} is now kept ${delayText(delay)} behind the primary of ${db.name} (restore delay). It can no longer be failed over to.`, refs);
            else if (delay === 0) events.add('info', 'restore', `${rep.server_name} is no longer kept behind for ${db.name}: it catches up now, and can be failed over to again.`, refs);
            else events.add('info', 'restore', `The restore delay of ${db.name} on ${rep.server_name} is now ${delayText(delay)} (was ${delayText(before)}).`, refs);
        }
        changed(db, rep.server_id);
        if (delay < before) nudge(db.id, rep.server_id, { force: true });
        return updated;
    });

    // Hold the restores of a delayed secondary while someone investigates on it:
    // nobody is disconnected by a restore meanwhile. At most 24 hours, because
    // the backup share keeps every log the copy has not restored.
    router.post('/api/databases/:id/replicas/:serverId/pause', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        if (!(rep.restore_delay_minutes > 0)) throw new HttpError(409, `Only a secondary with a restore delay can be paused; ${rep.server_name} has none`);
        const hours = Number(ctx.body?.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > MAX_PAUSE_HOURS) throw new HttpError(400, `Pause for 1 to ${MAX_PAUSE_HOURS} hours`);
        const updated = databases.updateReplica(db.id, rep.server_id, { restores_paused_until: new Date(Date.now() + hours * 3_600_000).toISOString() });
        events.add('info', 'restore', `Restores of ${db.name} on ${rep.server_name} are paused for ${hours} h. They resume by themselves after that, or with Resume restores.`, {
            databaseId: db.id,
            serverId: rep.server_id,
            data: { until: updated.restores_paused_until },
        });
        changed(db, rep.server_id);
        return updated;
    });

    router.post('/api/databases/:id/replicas/:serverId/resume', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        if (!isPaused(rep)) throw new HttpError(409, `Restores of ${db.name} on ${rep.server_name} are not paused`);
        // A past time: catching up, without lag alerts until it is back where its delay says.
        const updated = databases.updateReplica(db.id, rep.server_id, { restores_paused_until: nowIso() });
        events.add('info', 'restore', `Restores of ${db.name} on ${rep.server_name} resume`, { databaseId: db.id, serverId: rep.server_id });
        changed(db, rep.server_id);
        nudge(db.id, rep.server_id, { force: true });
        return updated;
    });

    // After fixing the cause of a broken chain (e.g. putting a missing file
    // back), let the restore loop try again. It stops again if nothing changed.
    router.post('/api/databases/:id/replicas/:serverId/recheck', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = mustGetSecondary(db, idParam(ctx.params.serverId, 'serverId'));
        if (!['broken', 'needs_reseed'].includes(rep.chain_state)) throw new HttpError(409, `Shipping to ${rep.server_name} has not stopped, so there is nothing to try again`);
        let found = 0;
        for (const f of backups.all(db.id)) {
            if (f.file_status === 'missing' && fileOnDisk(f)) found++;
        }
        databases.updateReplica(db.id, rep.server_id, { chain_state: 'ok', chain_reason: null });
        events.add('info', 'restore', `Trying shipping of ${db.name} to ${rep.server_name} again${found ? ` (${found} missing backup file(s) are back)` : ''}`, {
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
