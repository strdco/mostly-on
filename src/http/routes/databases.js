import { HttpError, idParam } from '../router.js';
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as backups from '../../store/repos/backups.js';
import * as forks from '../../store/repos/forks.js';
import * as schedules from '../../store/repos/schedules.js';
import * as foreign from '../../store/repos/foreign.js';
import * as ops from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import * as inspect from '../../sql/inspect.js';
import * as health from '../../engine/health.js';
import * as retention from '../../engine/retention.js';
import * as settings from '../../store/repos/settings.js';
import { checkRetention, effectiveRetention, globalRetention } from '../../engine/retention-rules.js';
import { startBackup, BACKUP_TYPES } from '../../engine/backup.js';
import { validateSchedule } from '../../engine/schedule-math.js';
import { holders } from '../../engine/locks.js';
import { lagOf } from '../../engine/restore-loop.js';
import { canResume, canResolve } from '../../engine/ops/index.js';
import { sqlErrorText } from '../../sql/pool.js';
import { evaluateSoon } from '../../notify/alerts.js';
import { publish } from '../../bus.js';

function mustGet(id) {
    const db = databases.get(id);
    if (!db || db.status !== 'managed') throw new HttpError(404, 'Database not found or not managed');
    return db;
}

/** Catalog intent joined with the live state from the latest health checks. */
function summary(db) {
    const rows = databases.replicas(db.id);
    const lags = lagOf(db.id, rows);
    const replicas = rows.map((r) => {
        const h = health.getHealth(r.server_id);
        const live = health.dbState(r.server_id, db.name);
        return {
            ...r,
            reachable: h ? h.ok : null,
            live: live ? { state: live.state, recoveryModel: live.recoveryModel, userAccess: live.userAccess, isInStandby: live.isInStandby } : null,
            lag: lags.get(r.server_id) || null,
        };
    });
    return {
        id: db.id,
        name: db.name,
        family_guid: db.family_guid,
        created_at: db.created_at,
        primary: replicas.find((r) => r.role === 'primary') || null,
        replicas,
        latest: backups.latestByType(db.id),
        schedules: schedules.list(db.id),
        foreignLogBackups: foreign.unacknowledged(db.id),
        busy: holders(db.id),
        // own: this database's values (null = the global default); effective: what retention uses.
        retention: {
            own: { full: db.retention_full_days ?? null, diff: db.retention_diff_days ?? null, log: db.retention_log_days ?? null },
            effective: effectiveRetention(db, globalRetention(settings.all())),
        },
    };
}

export function databaseRoutes(router) {
    router.get('/api/databases', async () => databases.list().map(summary));

    router.get('/api/databases/:id', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        return {
            ...summary(db),
            foreignBackups: foreign.list(db.id),
            operations: ops.list({ databaseId: db.id, limit: 20 }).map((op) => ({ ...op, database_name: db.name, resumable: canResume(op), resolvable: canResolve(op) })),
        };
    });

    router.get('/api/databases/:id/backups', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.query.type;
        if (type && !['FULL', 'DIFF', 'LOG', 'DIVERGED'].includes(type)) throw new HttpError(400, 'Invalid type');
        return backups.list({ databaseId: db.id, type, limit: Number(ctx.query.limit) || 200 });
    });

    // Start managing a database discovered on a server; it becomes the primary.
    router.post('/api/databases', async (ctx) => {
        const serverId = idParam(ctx.body?.server_id, 'server_id');
        const name = ctx.body?.name;
        if (typeof name !== 'string' || !name || name.length > 128) throw new HttpError(400, 'name is required');
        const server = serversRepo.get(serverId);
        if (!server) throw new HttpError(404, 'Server not found');
        const existing = databases.getByName(name);
        if (existing?.status === 'managed') throw new HttpError(409, `${name} is already managed`);

        let state;
        try {
            state = await inspect.dbBackupState(serverId, name);
        } catch (err) {
            throw new HttpError(503, `Cannot reach ${server.name}: ${sqlErrorText(err)}`);
        }
        if (!state) throw new HttpError(404, `Database ${name} does not exist on ${server.name}`);
        if (state.state !== 'ONLINE') throw new HttpError(409, `Database ${name} is ${state.state} on ${server.name}`);
        if (state.recoveryModel !== 'FULL') {
            throw new HttpError(409, `Database ${name} uses the ${state.recoveryModel} recovery model and cannot be log shipped. Switch it to FULL first.`);
        }

        const db = databases.manage({ name, familyGuid: state.familyGuid, primaryServerId: serverId });
        forks.reset(db.id, state.recoveryForkGuid);
        databases.noteOwner(db.id, state);
        events.add('info', 'database', `Started managing ${name} with primary ${server.name}`, { databaseId: db.id, serverId });
        publish('database.changed', { databaseId: db.id });

        // A FULL backup starts the controller's chain immediately.
        let operation = null;
        let warning = null;
        try {
            const started = await startBackup(db.id, 'FULL', { trigger: 'manage' });
            operation = started.operation;
        } catch (err) {
            warning = `Initial FULL backup could not start: ${err.message}`;
        }
        ctx.status = 201;
        return { database: summary(db), operation, warning };
    });

    router.post('/api/databases/:id/unmanage', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        if (ctx.body?.confirm !== db.name) throw new HttpError(400, 'Type the database name to confirm');
        if (holders(db.id).length) throw new HttpError(409, `${db.name} is busy (${holders(db.id).join(', ')})`);
        databases.unmanage(db.id);
        events.add('warn', 'database', `Stopped managing ${db.name}. Backups and schedules for it have stopped; files on disk are kept.`, { databaseId: db.id });
        publish('database.changed', { databaseId: db.id });
        return { ok: true };
    });

    router.post('/api/databases/:id/backups', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.body?.type;
        if (!BACKUP_TYPES.includes(type)) throw new HttpError(400, 'type must be FULL, DIFF or LOG');
        const started = await startBackup(db.id, type, { trigger: 'manual' });
        ctx.status = 202;
        return { operation: started.operation, type: started.type };
    });

    router.put('/api/databases/:id/schedules/:type', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.params.type;
        if (!BACKUP_TYPES.includes(type)) throw new HttpError(400, 'Invalid backup type');
        const v = validateSchedule(ctx.body || {});
        const s = schedules.update(db.id, type, v);
        events.add('info', 'schedule', `${type} schedule of ${db.name} changed`, { databaseId: db.id, data: v });
        publish('database.changed', { databaseId: db.id });
        return s;
    });

    router.get('/api/discovered', async (ctx) => databases.discovered({ includeDismissed: ctx.query.include_dismissed === '1' }));

    router.post('/api/discovered/dismiss', async (ctx) => {
        const serverId = idParam(ctx.body?.server_id, 'server_id');
        if (typeof ctx.body?.name !== 'string') throw new HttpError(400, 'name is required');
        if (!databases.dismissDiscovered(serverId, ctx.body.name, ctx.body.dismissed !== false)) throw new HttpError(404, 'Not found');
        publish('discovery.changed', { serverId });
        return { ok: true };
    });

    router.post('/api/foreign-backups/:uuid/acknowledge', async (ctx) => {
        if (!foreign.acknowledge(String(ctx.params.uuid).toLowerCase())) throw new HttpError(404, 'Unknown or already acknowledged');
        evaluateSoon();
        events.add('info', 'foreign-backup', `Backup taken outside Mostly On acknowledged (backup set ${ctx.params.uuid})`);
        return { ok: true };
    });

    // A database's own retention days; null (or empty) = use the global value.
    router.put('/api/databases/:id/retention', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const b = ctx.body || {};
        const days = (k) => {
            const v = b[k];
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 3650) throw new HttpError(400, `${k} must be a whole number of days (1-3650), or empty for the default`);
            return n;
        };
        const own = { full: days('full_days'), diff: days('diff_days'), log: days('log_days') };
        const effective = effectiveRetention({ retention_full_days: own.full, retention_diff_days: own.diff, retention_log_days: own.log }, globalRetention(settings.all()));
        const problem = checkRetention(effective);
        if (problem) throw new HttpError(400, problem);
        const updated = databases.setRetention(db.id, own);
        events.add('info', 'retention', `Backup retention of ${db.name}: FULL ${effective.full}, DIFF ${effective.diff}, LOG ${effective.log} days`, { databaseId: db.id, data: own });
        publish('database.changed', { databaseId: db.id });
        return summary(updated);
    });

    router.post('/api/retention/run', async (ctx) => retention.runAll({ dryRun: ctx.body?.dryRun !== false }));
}
