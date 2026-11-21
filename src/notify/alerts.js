// Alerts: every alerts.interval_seconds, derive the set of current problems
// from the catalog and the health snapshots, run it through the dedupe state
// machine (alert-state.js) and push one batched notification.
//
// Conditions (stable keys):
//   server:<srv>          an enabled server is unreachable
//   dbstate:<db>:<srv>    not ONLINE on the primary / not RESTORING (or STANDBY) on a secondary
//   chain:<db>:<srv>      shipping stopped: chain broken or reseed needed
//   lag:<db>:<srv>        a secondary is further behind than alerts.lag_threshold_minutes
//   restore:<db>:<srv>    the last restore attempt on a secondary failed
//   backup:<db>:<TYPE>    the last backup of a type failed and none succeeded since
//   foreign:<uuid>        a backup Mostly On did not take
//   diverged:<db>:<srv>   an old primary holds a diverged copy (reseed it)
//   split:<db>:<srv>      ... and it is ONLINE and writable (split-brain risk)
//   op:<id>               a seed, reseed or failover failed or was interrupted
// Database conditions are suppressed while a failover or reseed holds the
// database (their own failure raises op:<id>), and per-database checks on an
// unreachable server are left to server:<srv>.
import * as alertsRepo from '../store/repos/alerts.js';
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as restores from '../store/repos/restores.js';
import * as ops from '../store/repos/operations.js';
import * as foreign from '../store/repos/foreign.js';
import * as settings from '../store/repos/settings.js';
import * as events from '../store/repos/events.js';
import * as health from '../engine/health.js';
import * as notifier from './notifier.js';
import { getDb } from '../store/db.js';
import { holders } from '../engine/locks.js';
import { lagOf } from '../engine/restore-loop.js';
import { engineConfig } from '../engine/context.js';
import { publish } from '../bus.js';
import { log } from '../log.js';
import { createMemo, decide, formatBatch, formatDuration } from './alert-state.js';

const OP_TITLES = { seed: 'Adding a secondary', reseed: 'Reinitialize', planned_failover: 'Failover', forced_failover: 'Forced failover', switchover_all: 'Fail over all databases' };
const RESOLVED_KEEP_DAYS = 90;
// Conditions a person clears (Mark resolved, Acknowledge): no flapping, so no resolve debounce.
const INSTANT_KINDS = new Set(['operation', 'foreign_backup']);

let memo = createMemo();
let timer = null;
let running = false;
const delivery = { lastSentAt: null, lastError: null, failures: 0, nextAttemptAt: 0 };

function links() {
    const base = engineConfig().publicUrl;
    return {
        base,
        db: (id) => `${base}/#/databases/${id}`,
        server: (id) => `${base}/#/servers/${id}`,
        ops: `${base}/#/operations`,
    };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The current problems, keyed by condition key. */
export function collectConditions() {
    const out = new Map();
    const add = (c) => out.set(c.key, c);
    const link = links();

    const reachable = new Set();
    for (const s of serversRepo.list()) {
        if (!s.enabled) continue;
        const h = health.getHealth(s.id);
        if (h?.ok) reachable.add(s.id);
        else if (h) add({ key: `server:${s.id}`, kind: 'server_unreachable', severity: 'error', message: `Server ${s.name} is unreachable: ${h.error}`, serverId: s.id, link: link.server(s.id) });
    }

    const thresholdSeconds = settings.get('alerts.lag_threshold_minutes') * 60;
    for (const db of databases.list()) {
        const reps = databases.replicas(db.id);
        const busy = holders(db.id).includes('exclusive');
        const primary = reps.find((r) => r.role === 'primary');
        const lags = lagOf(db.id, reps);
        const ref = (r, extra) => ({ databaseId: db.id, serverId: r.server_id, link: link.db(db.id), ...extra });

        for (const r of reps) {
            const up = reachable.has(r.server_id);
            const live = up ? health.dbState(r.server_id, db.name) : null;
            const stateText = live ? (live.isInStandby ? 'STANDBY' : live.state) : 'missing';

            if (r.role === 'primary') {
                if (up && !busy && (!live || live.state !== 'ONLINE' || live.isInStandby)) {
                    add(ref(r, { key: `dbstate:${db.id}:${r.server_id}`, kind: 'db_state', severity: 'error', message: `${db.name} is ${stateText} on its primary ${r.server_name}` }));
                }
                continue;
            }

            if (r.role === 'diverged') {
                add(ref(r, { key: `diverged:${db.id}:${r.server_id}`, kind: 'diverged', severity: 'warn', message: `${r.server_name} holds an old, out-of-sync copy of ${db.name} after a failover; reinitialize it (Reinitialize) to make it a secondary again` }));
                if (live?.state === 'ONLINE' && !live.isInStandby) {
                    add(ref(r, { key: `split:${db.id}:${r.server_id}`, kind: 'split_brain', severity: 'error', message: `The old copy of ${db.name} on ${r.server_name} is online and accepts changes, so two servers may be taking changes at once (split brain); take it offline or reinitialize it` }));
                }
                continue;
            }

            // secondary
            if (r.chain_state === 'seeding') continue;
            if (r.chain_state === 'broken' || r.chain_state === 'needs_reseed') {
                const what = r.chain_state === 'broken' ? 'has stopped' : 'has stopped, and the copy needs reinitializing';
                add(ref(r, { key: `chain:${db.id}:${r.server_id}`, kind: 'chain', severity: 'error', message: `Shipping of ${db.name} to ${r.server_name} ${what}${r.chain_reason ? `: ${r.chain_reason}` : ''}` }));
            }
            if (busy || !up || r.chain_state !== 'ok') continue;
            if (!live || !(live.state === 'RESTORING' || (live.state === 'ONLINE' && live.isInStandby))) {
                add(ref(r, { key: `dbstate:${db.id}:${r.server_id}`, kind: 'db_state', severity: 'error', message: `${db.name} on the secondary ${r.server_name} is ${stateText} instead of receiving (RESTORING)` }));
            }
            const l = lags.get(r.server_id);
            if (primary && reachable.has(primary.server_id) && l?.seconds != null && l.seconds > thresholdSeconds) {
                add(ref(r, {
                    key: `lag:${db.id}:${r.server_id}`,
                    kind: 'lag',
                    severity: 'warn',
                    message:
                        `${db.name} on ${r.server_name} is ${formatDuration(l.seconds)} behind (${plural(l.files ?? 0, 'log')} not restored yet; threshold ${formatDuration(thresholdSeconds)})`,
                }));
            }
            const [last] = restores.list({ databaseId: db.id, serverId: r.server_id, limit: 1 });
            if (last?.outcome === 'failed') {
                add(ref(r, { key: `restore:${db.id}:${r.server_id}`, kind: 'restore_failed', severity: 'error', message: `Restoring ${db.name} on ${r.server_name} failed: ${last.error || 'unknown error'}` }));
            }
        }
    }

    const dbNames = new Map(databases.list().map((d) => [d.id, d.name]));
    for (const f of ops.failedBackups()) {
        add({
            key: `backup:${f.database_id}:${f.backup_type}`,
            kind: 'backup_failed',
            severity: 'error',
            message: `${f.backup_type} backup of ${dbNames.get(f.database_id) ?? `database #${f.database_id}`} ${f.status === 'interrupted' ? 'was interrupted' : 'failed'}${f.error ? `: ${f.error}` : ''}`,
            databaseId: f.database_id,
            link: link.db(f.database_id),
        });
    }

    for (const f of foreign.allUnacknowledged()) {
        add({
            key: `foreign:${f.backup_set_uuid}`,
            kind: 'foreign_backup',
            severity: f.type === 'LOG' ? 'error' : 'warn',
            message: `A ${f.type} backup of ${f.database_name} was taken outside Mostly On, on ${f.server_name} (${f.device})${f.type === 'LOG' ? '. The secondaries never get the changes in it, so shipping stops' : ''}`,
            databaseId: f.database_id,
            serverId: f.server_id,
            link: link.db(f.database_id),
        });
    }

    for (const o of ops.needingAttention()) {
        const name = o.database_id ? dbNames.get(o.database_id) : null;
        add({
            key: `op:${o.id}`,
            kind: 'operation',
            severity: 'error',
            message: `${OP_TITLES[o.type] || o.type} #${o.id}${name ? ` of ${name}` : ''} ${o.status === 'interrupted' ? 'was interrupted' : 'failed'}${o.error ? `: ${o.error.replace(/[.\s]+$/, '')}` : ''}. Resume it or mark it resolved.`,
            databaseId: o.database_id,
            serverId: o.server_id,
            link: link.ops,
        });
    }
    return out;
}

function noticeLink(n, link) {
    if (n.link) return n;
    if (n.kind === 'operation') return { ...n, link: link.ops };
    if (n.databaseId) return { ...n, link: link.db(n.databaseId) };
    if (n.serverId) return { ...n, link: link.server(n.serverId) };
    return n;
}

/** One evaluation. Exported for tests and the API. */
export async function tick(now = Date.now()) {
    const s = settings.all();
    const debounceMs = s['alerts.debounce_seconds'] * 1000;
    const rows = new Map(alertsRepo.all().map((r) => [r.key, r]));
    const { writes, notices } = decide({
        conditions: collectConditions(),
        rows,
        memo,
        now,
        reminderMs: s['alerts.reminder_hours'] * 3_600_000,
        confirmMs: debounceMs,
        resolveMs: debounceMs,
        instantKinds: INSTANT_KINDS,
    });

    if (writes.length) {
        getDb().transaction(() => writes.forEach((w) => alertsRepo.upsert(w)))();
        for (const w of writes) {
            const before = rows.get(w.key);
            if (w.status === 'active' && before?.status !== 'active') events.add('info', 'alert', `Alert raised: ${w.message}`, { databaseId: w.database_id, serverId: w.server_id });
            else if (w.status === 'resolved' && before?.status === 'active') events.add('info', 'alert', `Alert resolved: ${w.message}`, { databaseId: w.database_id, serverId: w.server_id });
        }
        publish('alert.changed', {});
    }
    alertsRepo.purgeResolved(new Date(now - RESOLVED_KEEP_DAYS * 86_400_000).toISOString());

    if (!notices.length || !notifier.anyConfigured() || now < delivery.nextAttemptAt) return { writes, notices, sent: false };
    const link = links();
    const msg = formatBatch(notices.map((n) => noticeLink(n, link)), { publicUrl: link.base, now });
    try {
        await notifier.sendAll(msg);
        alertsRepo.markNotified([...new Set(notices.map((n) => n.key))], new Date(now).toISOString());
        if (delivery.failures) events.add('info', 'notify', 'Notifications are being delivered again');
        Object.assign(delivery, { lastSentAt: new Date().toISOString(), lastError: null, failures: 0, nextAttemptAt: 0 });
        publish('alert.changed', {});
        return { writes, notices, sent: true };
    } catch (err) {
        delivery.failures++;
        delivery.lastError = err.message;
        delivery.nextAttemptAt = now + Math.min(60_000 * 2 ** (delivery.failures - 1), 30 * 60_000);
        // Once per failure streak; the retry keeps going with backoff.
        if (delivery.failures === 1) events.add('warn', 'notify', `Could not send a notification (${err.message}); retrying with backoff`);
        return { writes, notices, sent: false, error: err.message };
    }
}

/** Re-evaluates shortly, after a user action that clears a condition. */
export function evaluateSoon() {
    if (!loopFn) return; // not started (tests)
    if (running) {
        soon = true; // the running evaluation schedules the next one quickly
        return;
    }
    clearTimeout(timer); // there is exactly one pending timer; replace it
    timer = setTimeout(loopFn, 300);
    timer.unref?.();
}

export function deliveryStatus() {
    return {
        channels: notifier.status(),
        lastSentAt: delivery.lastSentAt,
        lastError: delivery.lastError,
        nextAttemptAt: delivery.nextAttemptAt ? new Date(delivery.nextAttemptAt).toISOString() : null,
    };
}

export async function sendTest() {
    const { base } = links();
    const r = await notifier.sendAll({
        title: 'Mostly On: test notification',
        message: `This is a test from Mostly On at ${base}. Alerts will arrive like this.`,
        priority: 0,
        url: base,
        urlTitle: 'Open Mostly On',
    });
    delivery.lastSentAt = new Date().toISOString();
    events.add('info', 'notify', `Test notification sent (${r.sent.join(', ')})`);
    return r;
}

let loopFn = null;
let soon = false;

export function start() {
    if (timer) return;
    // One chain of timers: only this function schedules the next run (evaluateSoon
    // replaces the pending timer, or asks this run to come back quickly).
    const loop = async () => {
        running = true;
        try {
            await tick();
        } catch (err) {
            log.error('Alert evaluation failed', { err });
        } finally {
            running = false;
        }
        timer = setTimeout(loop, soon ? 300 : settings.get('alerts.interval_seconds') * 1000);
        soon = false;
        timer.unref?.();
    };
    loopFn = loop;
    // Let the restore loops and the first health checks settle first.
    timer = setTimeout(loop, 5000);
    timer.unref?.();
}

export function stop() {
    clearTimeout(timer);
    timer = null;
    loopFn = null;
}

/** Test helper. */
export function _resetMemo() {
    memo = createMemo();
}
