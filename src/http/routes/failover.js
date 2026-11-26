// Failovers, switch-over of a whole server, reseed, handling of diverged copies
// and point-in-time restores.
import { HttpError, idParam, actorOf } from '../router.js';
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as events from '../../store/repos/events.js';
import * as P from '../../sql/privileged.js';
import { sqlErrorText } from '../../sql/pool.js';
import { failoverPreview, startFailover } from '../../engine/ops/failover.js';
import { switchoverPlan, switchoverTargets, startSwitchoverAll } from '../../engine/ops/switchover-all.js';
import { startSeed } from '../../engine/ops/seed.js';
import { restoreRange, startPointInTime } from '../../engine/ops/pitr.js';
import { holders } from '../../engine/locks.js';
import { publish } from '../../bus.js';

function mustGetDb(id) {
    const db = databases.get(id);
    if (!db || db.status !== 'managed') throw new HttpError(404, 'Database not found or not managed');
    return db;
}

export function failoverRoutes(router) {
    router.get('/api/databases/:id/failover-preview', async (ctx) => failoverPreview(idParam(ctx.params.id), idParam(ctx.query.server_id, 'server_id')));

    // { server_id, tail_log, accept_data_loss }. With tail_log it is a
    // lossless planned failover when possible; see startFailover().
    router.post('/api/databases/:id/failover', async (ctx) => {
        const b = ctx.body || {};
        const started = await startFailover(idParam(ctx.params.id), {
            serverId: idParam(b.server_id, 'server_id'),
            tailLog: b.tail_log !== false,
            acceptDataLoss: b.accept_data_loss === true,
            actor: actorOf(ctx),
        });
        ctx.status = 202;
        return { operation: started.operation };
    });

    // The moments the database can be restored to, and the servers a copy can go to.
    router.get('/api/databases/:id/restore-range', async (ctx) => restoreRange(idParam(ctx.params.id)));

    // { mode: 'copy', at, target_server_id, new_name } or { mode: 'rollback', at, confirm }.
    router.post('/api/databases/:id/point-in-time', async (ctx) => {
        const b = ctx.body || {};
        const started = await startPointInTime(idParam(ctx.params.id), {
            mode: b.mode,
            at: b.at,
            targetServerId: b.mode === 'copy' ? idParam(b.target_server_id, 'target_server_id') : null,
            newName: b.new_name,
            confirm: b.confirm,
            actor: actorOf(ctx),
        });
        ctx.status = 202;
        return { operation: started.operation };
    });

    // Replace a diverged (or otherwise unusable) copy with a fresh seed from the primary.
    router.post('/api/databases/:id/replicas/:serverId/reseed', async (ctx) => {
        const b = ctx.body || {};
        const started = await startSeed(idParam(ctx.params.id), {
            serverId: idParam(ctx.params.serverId, 'serverId'),
            source: b.source || 'new_full',
            restoreMode: b.restore_mode || 'norecovery',
            confirm: typeof b.confirm === 'string' ? b.confirm : null,
            reseed: true,
            safetyBackup: b.safety_backup !== false,
            actor: actorOf(ctx),
        });
        ctx.status = 202;
        return { operation: started.operation };
    });

    // Split-brain guard: take a diverged copy offline so nothing can write to it.
    router.post('/api/databases/:id/replicas/:serverId/take-offline', async (ctx) => {
        const db = mustGetDb(idParam(ctx.params.id));
        const rep = databases.replica(db.id, idParam(ctx.params.serverId, 'serverId'));
        if (!rep || rep.role !== 'diverged') throw new HttpError(409, 'Only a diverged copy can be taken offline here');
        if (ctx.body?.confirm !== db.name) throw new HttpError(400, 'Type the database name to confirm');
        if (holders(db.id).some((k) => k === 'exclusive' || k === `restore:${rep.server_id}`)) throw new HttpError(409, `${rep.server_name} is busy`);
        try {
            await P.run(rep.server_id, P.setState({ db: db.name, state: 'OFFLINE' }), { timeoutMs: 120_000 });
        } catch (err) {
            throw new HttpError(502, `Could not take ${db.name} offline on ${rep.server_name}: ${sqlErrorText(err)}`);
        }
        events.add('warn', 'failover', `The old, out-of-sync copy of ${db.name} on ${rep.server_name} was taken offline`, {
            databaseId: db.id,
            serverId: rep.server_id,
            actor: actorOf(ctx),
            errorLog: [rep.server_id],
        });
        publish('replica.changed', { databaseId: db.id, serverId: rep.server_id });
        return { ok: true };
    });

    // Servers the primaries on this server can fail over to (each with how many it covers).
    router.get('/api/servers/:id/switchover-targets', async (ctx) => switchoverTargets(idParam(ctx.params.id)));

    router.get('/api/servers/:id/switchover-plan', async (ctx) => {
        const { from, to, items } = switchoverPlan(idParam(ctx.params.id), idParam(ctx.query.to, 'to'));
        return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, databases: items };
    });

    router.post('/api/servers/:id/switchover', async (ctx) => {
        const started = await startSwitchoverAll({
            fromServerId: idParam(ctx.params.id),
            toServerId: idParam(ctx.body?.to_server_id, 'to_server_id'),
            confirm: ctx.body?.confirm,
            actor: actorOf(ctx),
        });
        ctx.status = 202;
        return { operation: started.operation };
    });

    router.get('/api/servers/:id/roles', async (ctx) => {
        const s = serversRepo.get(idParam(ctx.params.id));
        if (!s) throw new HttpError(404, 'Server not found');
        return databases.replicasOnServer(s.id);
    });
}
