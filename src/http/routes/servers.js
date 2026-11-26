import { HttpError, idParam, actorOf } from '../router.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as events from '../../store/repos/events.js';
import * as databases from '../../store/repos/databases.js';
import * as ops from '../../store/repos/operations.js';
import { evaluateSoon } from '../../notify/alerts.js';
import * as health from '../../engine/health.js';
import { resetPool, testConnection, sqlErrorText } from '../../sql/pool.js';
import { setupScriptFor } from '../../sql/setup-script.js';
import { slotStatus } from '../../sql/slots.js';
import { runPass } from '../../engine/auto-manage.js';
import { log } from '../../log.js';

const ROLE_WORDS = { primary: ['primary copy', 'primary copies'], secondary: ['secondary copy', 'secondary copies'], diverged: ['out-of-sync copy', 'out-of-sync copies'] };

/** "1 primary copy and 3 secondary copies": counts per role, never a list of names. */
function copyCounts(reps) {
    const parts = Object.entries(ROLE_WORDS)
        .map(([role, [one, many]]) => [reps.filter((r) => r.role === role).length, one, many])
        .filter(([n]) => n > 0)
        .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

/**
 * Why a server cannot be removed right now (null if it can): it still holds a
 * copy of a managed database, or an unfinished operation involves it.
 */
export function removeBlocker(id) {
    const all = databases.replicasOnServer(id);
    const reps = all.filter((r) => r.backup_only_server_id == null);
    const backupOnly = all.length - reps.length;
    if (reps.length) {
        return `It still holds ${copyCounts(reps)} of managed databases (listed on its page). Fail over or remove them first.`;
    }
    if (backupOnly) {
        return `Mostly-On backs up ${backupOnly === 1 ? '1 database' : `${backupOnly} databases`} only on this server (listed on its page). Stop managing ${backupOnly === 1 ? 'it' : 'them'} first.`;
    }
    const involves = (op) => op.server_id === id || Object.entries(op.params || {}).some(([k, v]) => /ServerId$/.test(k) && v === id);
    const op = [...ops.unfinished(), ...ops.needingAttention()].find(involves);
    if (op) {
        return op.status === 'running' || op.status === 'queued'
            ? `Operation #${op.id} involving it is still running; wait until it has finished.`
            : `Operation #${op.id} involving it stopped before it finished. Resume it or mark it resolved first (Operations page).`;
    }
    return null;
}

function withHealth(s) {
    const h = health.getHealth(s.id);
    return {
        ...s,
        remove_blocker: s.removed_at ? null : removeBlocker(s.id),
        work: slotStatus(s.id), // backups and restores: the limit, running now, waiting
        health: h
            ? { ok: h.ok, checkedAt: h.checkedAt, error: h.error, warnings: h.warnings, info: h.info, databases: h.databases, setup: h.setup }
            : null,
    };
}

/** User databases on a server that automatic management would start managing. */
function wouldManage(serverId) {
    const skip = databases.stoppedByPersonOn(serverId);
    return databases
        .discovered()
        .filter((d) => d.server_id === serverId && !d.system && d.state === 'ONLINE' && !skip.has(d.name))
        .map((d) => d.name);
}

function mustGet(id) {
    const s = serversRepo.get(id);
    if (!s) throw new HttpError(404, 'Server not found');
    return s;
}

/** Throws unless the edit v keeps the saved password with the settings it was saved with, or brings its own. */
function requirePasswordForNewConnection(saved, v) {
    if (v.password !== undefined) return;
    const changed = serversRepo.changedConnectionSettings(saved, v);
    if (changed.length) {
        throw new HttpError(400, `Enter the password again: you changed the ${changed.join(', ')}, and Mostly-On only sends a saved password with the connection settings it was saved with.`);
    }
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
        const existing = serversRepo.getByName(v.name);
        if (existing && !existing.removed_at) throw new HttpError(409, `A server named ${v.name} already exists`);
        // A removed server registered again gets its old record back (and its history), with the new details.
        const s = existing ? serversRepo.revive(existing.id, v, cfg.secretKeyBytes) : serversRepo.create(v, cfg.secretKeyBytes);
        events.add('info', 'server', `Server ${s.name} ${existing ? 'registered again' : 'registered'} (${s.host}:${s.port})`, { serverId: s.id, actor: actorOf(ctx) });
        await health.checkServer(s.id);
        evaluateSoon();
        ctx.status = 201;
        return withHealth(serversRepo.get(s.id));
    });

    router.put('/api/servers/:id', async (ctx) => {
        const id = idParam(ctx.params.id);
        const before = mustGet(id);
        if (before.removed_at) throw new HttpError(409, `${before.name} was removed. To use it again, register it again under the same name.`);
        const v = serversRepo.validate(ctx.body || {}, { partial: true });
        requirePasswordForNewConnection(before, v);
        if (v.name && v.name !== before.name) {
            if (serversRepo.replicaCount(id) > 0) throw new HttpError(409, 'Cannot rename a server that holds managed replicas (the name is part of backup file names)');
            const taken = serversRepo.getByName(v.name);
            if (taken?.removed_at) throw new HttpError(409, `${v.name} is the name of a removed server, whose backup files still carry it. Choose another name, or register that server again under it.`);
            if (taken) throw new HttpError(409, `A server named ${v.name} already exists`);
        }
        const reconnect = v.password !== undefined || serversRepo.changedConnectionSettings(before, v).length > 0;
        serversRepo.update(id, v, cfg.secretKeyBytes);
        // New connection details: reconnect. Anything else (a name, folders, the limit) keeps the
        // connections, so running backups and restores are not cut off.
        if (reconnect) await resetPool(id);
        events.add('info', 'server', `Server ${before.name} updated`, { serverId: id, data: { fields: Object.keys(v).filter((k) => k !== 'password') }, actor: actorOf(ctx) });
        await health.checkServer(id);
        evaluateSoon(); // e.g. a setup alert, now that the check has the new settings
        return withHealth(serversRepo.get(id));
    });

    router.delete('/api/servers/:id', async (ctx) => {
        const id = idParam(ctx.params.id);
        const s = mustGet(id);
        if (s.removed_at) return { ok: true };
        const blocker = removeBlocker(id);
        if (blocker) throw new HttpError(409, `${s.name} cannot be removed yet. ${blocker}`);
        const how = serversRepo.removeOrRetire(id);
        await resetPool(id);
        health.forget(id);
        evaluateSoon(); // its alerts (unreachable, setup) no longer apply
        events.add('info', 'server', `Server ${s.name} removed${how === 'removed' ? '; its backup files and history are kept' : ''}`, { serverId: how === 'removed' ? id : null, actor: actorOf(ctx) });
        return { ok: true };
    });

    // Automatic management: what turning it on would do (the confirm dialog). ship_to: the target it would get.
    router.get('/api/servers/:id/auto-manage-preview', async (ctx) => {
        const s = mustGet(idParam(ctx.params.id));
        const target = ctx.query.ship_to ? mustGet(idParam(ctx.query.ship_to, 'ship_to')) : null;
        const pairs = target && !target.ship_to_server_id && target.id !== s.id;
        return {
            would_manage: s.auto_manage ? [] : wouldManage(s.id),
            paired: pairs ? { id: target.id, name: target.name, would_manage: target.auto_manage ? [] : wouldManage(target.id) } : null,
        };
    });

    // Turns automatic management on or off, with the default target for new
    // databases. A target without one of its own gets this server as its target
    // (a pair), so after a switchover new databases are shipped back.
    router.put('/api/servers/:id/auto-manage', async (ctx) => {
        const s = mustGet(idParam(ctx.params.id));
        if (s.removed_at) throw new HttpError(409, 'This server was removed');
        const on = ctx.body?.auto_manage === true;
        const raw = ctx.body?.ship_to_server_id;
        const shipTo = on && raw != null && raw !== '' ? idParam(raw, 'ship_to_server_id') : null;
        let target = null;
        if (shipTo) {
            target = mustGet(shipTo);
            if (target.removed_at) throw new HttpError(409, `${target.name} was removed`);
            if (target.id === s.id) throw new HttpError(400, 'A server cannot log ship to itself');
            if (!target.enabled) throw new HttpError(409, `${target.name} is disabled`);
        }
        serversRepo.setAutoManage(s.id, { autoManage: on, shipTo });
        events.add(
            'info',
            'server',
            on ? `${s.name} manages its databases automatically${target ? `; new ones are log shipped to ${target.name}` : ''}` : `${s.name} no longer manages its databases automatically`,
            { serverId: s.id, actor: actorOf(ctx) },
        );
        let paired = null;
        if (target && !target.ship_to_server_id) {
            serversRepo.setAutoManage(target.id, { autoManage: true, shipTo: s.id });
            paired = target.name;
            events.add('info', 'server', `${target.name} manages its databases automatically; new ones are log shipped to ${s.name} (paired with ${s.name})`, { serverId: target.id, actor: actorOf(ctx) });
        }
        for (const id of [s.id, target?.id].filter(Boolean)) runPass(id).catch((err) => log.error('Automatic management failed', { err }));
        return { server: withHealth(serversRepo.get(s.id)), paired };
    });

    router.post('/api/servers/:id/check', async (ctx) => {
        const id = idParam(ctx.params.id);
        if (mustGet(id).removed_at) throw new HttpError(409, 'This server was removed');
        await health.checkServer(id);
        evaluateSoon(); // a setup alert the check found fixed clears right away
        return withHealth(serversRepo.get(id));
    });

    // Try a connection with the given settings without saving anything.
    router.post('/api/servers/test-connection', async (ctx) => {
        const body = ctx.body || {};
        let v;
        if (body.id) {
            // Testing an edit of an existing server: fall back to the stored password,
            // but only with the connection settings it was saved with.
            const id = idParam(body.id);
            const edit = serversRepo.validate(body, { partial: true });
            requirePasswordForNewConnection(mustGet(id), edit);
            v = { ...serversRepo.getWithSecret(id, cfg.secretKeyBytes), ...edit };
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
