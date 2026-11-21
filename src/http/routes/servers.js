import { HttpError, idParam } from '../router.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as events from '../../store/repos/events.js';
import * as health from '../../engine/health.js';
import { resetPool, testConnection, sqlErrorText } from '../../sql/pool.js';
import { setupScriptFor } from '../../sql/setup-script.js';

function withHealth(s) {
    const h = health.getHealth(s.id);
    return {
        ...s,
        health: h
            ? { ok: h.ok, checkedAt: h.checkedAt, error: h.error, warnings: h.warnings, info: h.info, databases: h.databases, setup: h.setup }
            : null,
    };
}

function mustGet(id) {
    const s = serversRepo.get(id);
    if (!s) throw new HttpError(404, 'Server not found');
    return s;
}

export function serverRoutes(router, { cfg }) {
    router.get('/api/servers', async () => serversRepo.list().map(withHealth));

    router.get('/api/servers/:id', async (ctx) => withHealth(mustGet(idParam(ctx.params.id))));

    // The setup script for this server, values filled in (run it as sysadmin).
    router.get('/api/servers/:id/setup-script', async (ctx) => {
        const s = mustGet(idParam(ctx.params.id));
        const body = setupScriptFor(s);
        ctx.handled = true;
        ctx.res.writeHead(200, {
            'Content-Type': 'application/sql; charset=utf-8',
            'Content-Disposition': `attachment; filename="mostly-on-setup-${s.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.sql"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        ctx.res.end(body);
    });

    router.post('/api/servers', async (ctx) => {
        const v = serversRepo.validate(ctx.body || {});
        if (serversRepo.getByName(v.name)) throw new HttpError(409, `A server named ${v.name} already exists`);
        const s = serversRepo.create(v, cfg.secretKeyBytes);
        events.add('info', 'server', `Server ${s.name} registered (${s.host}:${s.port})`, { serverId: s.id });
        await health.checkServer(s.id);
        ctx.status = 201;
        return withHealth(serversRepo.get(s.id));
    });

    router.put('/api/servers/:id', async (ctx) => {
        const id = idParam(ctx.params.id);
        const before = mustGet(id);
        const v = serversRepo.validate(ctx.body || {}, { partial: true });
        if (v.name && v.name !== before.name) {
            if (serversRepo.replicaCount(id) > 0) throw new HttpError(409, 'Cannot rename a server that holds managed replicas (the name is part of backup file names)');
            if (serversRepo.getByName(v.name)) throw new HttpError(409, `A server named ${v.name} already exists`);
        }
        serversRepo.update(id, v, cfg.secretKeyBytes);
        await resetPool(id);
        events.add('info', 'server', `Server ${before.name} updated`, { serverId: id, data: { fields: Object.keys(v).filter((k) => k !== 'password') } });
        await health.checkServer(id);
        return withHealth(serversRepo.get(id));
    });

    router.delete('/api/servers/:id', async (ctx) => {
        const id = idParam(ctx.params.id);
        const s = mustGet(id);
        if (serversRepo.replicaCount(id) > 0) throw new HttpError(409, 'Server still holds managed replicas. Remove it from every database first.');
        try {
            serversRepo.remove(id);
        } catch (err) {
            if (/FOREIGN KEY/.test(err.message)) throw new HttpError(409, 'Server is still referenced by backup or restore history');
            throw err;
        }
        await resetPool(id);
        health.forget(id);
        events.add('info', 'server', `Server ${s.name} removed`, {});
        return { ok: true };
    });

    router.post('/api/servers/:id/check', async (ctx) => {
        const id = idParam(ctx.params.id);
        mustGet(id);
        await health.checkServer(id);
        return withHealth(serversRepo.get(id));
    });

    // Try a connection with the given settings without saving anything.
    router.post('/api/servers/test-connection', async (ctx) => {
        const body = ctx.body || {};
        let v;
        if (body.id) {
            // Testing an edit of an existing server: fall back to the stored password.
            const id = idParam(body.id);
            const stored = serversRepo.getWithSecret(id, cfg.secretKeyBytes);
            if (!stored) throw new HttpError(404, 'Server not found');
            v = { ...stored, ...serversRepo.validate(body, { partial: true }) };
        } else {
            v = serversRepo.validate(body);
        }
        try {
            const r = await testConnection(v);
            return { ok: true, productVersion: r.product_version };
        } catch (err) {
            return { ok: false, error: sqlErrorText(err) };
        }
    });
}
