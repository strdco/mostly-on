import { HttpError, idParam, actorOf } from '../router.js';
import * as databases from '../../store/repos/databases.js';
import * as backups from '../../store/repos/backups.js';
import * as schedules from '../../store/repos/schedules.js';
import * as foreign from '../../store/repos/foreign.js';
import * as ops from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import * as health from '../../engine/health.js';
import * as retention from '../../engine/retention.js';
import * as settings from '../../store/repos/settings.js';
import { checkRetention, effectiveRetention, globalRetention } from '../../engine/retention-rules.js';
import { startBackup, BACKUP_TYPES } from '../../engine/backup.js';
import { validateSchedule } from '../../engine/schedule-math.js';
import { holders } from '../../engine/locks.js';
import { lagOf } from '../../engine/restore-loop.js';
import { restoringNow } from '../../engine/restore.js';
import { canResume, canResolve } from '../../engine/ops/index.js';
import { evaluateSoon } from '../../notify/alerts.js';
import { syncFromHealth } from '../../engine/discovery.js';
import { manageDatabase } from '../../engine/manage.js';
import { publish } from '../../bus.js';
import { dbFolder } from '../../paths.js';
import { isBackupOnly, isSystemName, skippedTypes, dbLabel, SYSTEM_DATABASE_IDS, ONLY_FULL_MASTER } from '../../engine/backup-rules.js';

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
            // A RESTORE runs there right now (not just its restore lock, which a quick "anything new?" check also takes).
            restoring: restoringNow(db.id, r.server_id),
        };
    });
    const primary = replicas.find((r) => r.role === 'primary') || null;
    const primaryLive = primary ? health.dbState(primary.server_id, db.name) : null;
    const backupOnly = isBackupOnly(db);
    const system = primaryLive?.databaseId != null ? SYSTEM_DATABASE_IDS.includes(primaryLive.databaseId) : backupOnly && isSystemName(db.name);
    const recoveryModel = primaryLive?.recoveryModel ?? null;
    return {
        id: db.id,
        name: db.name,
        label: dbLabel(db),
        family_guid: db.family_guid,
        created_at: db.created_at,
        // Backups only: on this one server, never shipped, failed over or restored (engine/backup-rules.js).
        backup_only: backupOnly,
        server_name: backupOnly ? db.backup_only_server_name : null,
        folder: backupOnly ? dbFolder(db.name, db.backup_only_server_name) : null, // under the backup share
        system,
        recovery_model: recoveryModel,
        // Types that do not apply right now ({ DIFF: why, LOG: why }); their schedules are skipped.
        skipped: backupOnly ? skippedTypes(db, { recoveryModel, databaseId: primaryLive?.databaseId ?? null }, primary?.server_name) : {},
        // A backups-only user database now in FULL recovery could be log shipped (stop managing it, then manage it again).
        can_ship: backupOnly && !system && recoveryModel === 'FULL',
        latest_foreign: backupOnly ? (foreign.list(db.id)[0] ?? null) : null,
        primary,
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
            operations: ops.list({ databaseId: db.id, limit: 20 }).map((op) => ({ ...op, database_name: dbLabel(db), resumable: canResume(op), resolvable: canResolve(op) })),
        };
    });

    router.get('/api/databases/:id/backups', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.query.type;
        if (type && !['FULL', 'DIFF', 'LOG', 'DIVERGED'].includes(type)) throw new HttpError(400, 'Invalid type');
        return backups.list({ databaseId: db.id, type, limit: Number(ctx.query.limit) || 200 });
    });

    // Start managing a database discovered on a server; it becomes the primary.
    // A system database, or one not in FULL recovery, is managed as backups
    // only, on this server (engine/backup-rules.js); any other is log shipped.
    router.post('/api/databases', async (ctx) => {
        const serverId = idParam(ctx.body?.server_id, 'server_id');
        const name = ctx.body?.name;
        if (typeof name !== 'string' || !name || name.length > 128) throw new HttpError(400, 'name is required');
        const { db, operation, warning } = await manageDatabase({ serverId, name, actor: actorOf(ctx) });
        ctx.status = 201;
        return { database: summary(db), operation, warning };
    });

    router.post('/api/databases/:id/unmanage', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const blocker = databases.unmanageBlocker(db.id);
        if (blocker) throw new HttpError(409, `${db.name} cannot stop being managed yet. ${blocker}`);
        if (ctx.body?.confirm !== db.name) throw new HttpError(400, 'Type the database name to confirm');
        if (holders(db.id).length) throw new HttpError(409, `${db.name} is busy (${holders(db.id).join(', ')})`);
        const primary = databases.primaryOf(db.id);
        databases.unmanage(db.id);
        events.add('warn', 'database', `Stopped managing ${dbLabel(db)}. Backups and schedules for it have stopped; files on disk are kept.`, {
            databaseId: db.id,
            actor: actorOf(ctx),
            errorLog: [primary?.server_id],
        });
        // List it as unmanaged right away rather than at the next health check.
        if (primary) syncFromHealth(primary.server_id);
        publish('database.changed', { databaseId: db.id });
        return { ok: true };
    });

    router.post('/api/databases/:id/backups', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.body?.type;
        if (!BACKUP_TYPES.includes(type)) throw new HttpError(400, 'type must be FULL, DIFF or LOG');
        const started = await startBackup(db.id, type, { trigger: 'manual', actor: actorOf(ctx) });
        ctx.status = 202;
        return { operation: started.operation, type: started.type };
    });

    router.put('/api/databases/:id/schedules/:type', async (ctx) => {
        const db = mustGet(idParam(ctx.params.id));
        const type = ctx.params.type;
        if (!BACKUP_TYPES.includes(type)) throw new HttpError(400, 'Invalid backup type');
        if (!schedules.list(db.id).some((x) => x.backup_type === type)) {
            throw new HttpError(409, db.name === 'master' && isBackupOnly(db) ? ONLY_FULL_MASTER : `${dbLabel(db)} has no ${type} schedule`);
        }
        // { use_default: true }: follow the default schedule (Settings) again.
        if (ctx.body?.use_default === true) {
            const s = schedules.useDefault(db.id, type);
            events.add('info', 'schedule', `${type} schedule of ${dbLabel(db)} follows the default again`, { databaseId: db.id, actor: actorOf(ctx) });
            publish('database.changed', { databaseId: db.id });
            return s;
        }
        const v = validateSchedule(ctx.body || {});
        const s = schedules.update(db.id, type, v);
        events.add('info', 'schedule', `${type} schedule of ${dbLabel(db)} changed`, { databaseId: db.id, data: v, actor: actorOf(ctx) });
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
        events.add('info', 'foreign-backup', `Backup taken outside Mostly-On acknowledged (backup set ${ctx.params.uuid})`, { actor: actorOf(ctx) });
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
        events.add('info', 'retention', `Backup retention of ${dbLabel(db)}: FULL ${effective.full}, DIFF ${effective.diff}, LOG ${effective.log} days`, { databaseId: db.id, data: own, actor: actorOf(ctx) });
        publish('database.changed', { databaseId: db.id });
        return summary(updated);
    });

    router.post('/api/retention/run', async (ctx) => retention.runAll({ dryRun: ctx.body?.dryRun !== false, actor: actorOf(ctx) }));
}
