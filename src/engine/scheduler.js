// Internal backup scheduler (replaces SQL Server Agent).
//
// Every TICK_MS it looks for due schedules and starts backups on the current
// primary. A schedule missed while the controller was down runs once, then
// continues from "now"; there is no backfill of missed runs. If the database
// is busy (lock conflict) the schedule stays due and is retried next tick.
// A type that does not apply right now (a DIFF or LOG of a backups-only
// database that is not in FULL recovery) is skipped quietly until its next run.
import * as schedules from '../store/repos/schedules.js';
import * as databases from '../store/repos/databases.js';
import { startBackup } from './backup.js';
import { nextRun } from './schedule-math.js';
import { BusyError } from './locks.js';
import { pendingDrop } from './auto-manage.js';
import { log } from '../log.js';
import { publish } from '../bus.js';

const TICK_MS = 5000;
const RETRY_AFTER_FAILURE_MS = 60_000;

let timer = null;
const inflight = new Set(); // "dbId:type"
const lastBusyLog = new Map();

async function runOne(s) {
    const key = `${s.database_id}:${s.backup_type}`;
    inflight.add(key);
    const ranAt = new Date();
    try {
        const started = await startBackup(s.database_id, s.backup_type, { trigger: 'schedule' });
        const { operation } = await started.done;
        const ok = operation.status === 'succeeded';
        const status = ok ? (started.type !== s.backup_type ? `ok (took ${started.type})` : 'ok') : `failed: ${operation.error}`;
        const next = ok ? nextRun(s, new Date()) : new Date(Math.min(nextRun(s, new Date()).getTime(), Date.now() + RETRY_AFTER_FAILURE_MS));
        schedules.recordRun(s.database_id, s.backup_type, { ranAt: ranAt.toISOString(), status, nextRunAt: next.toISOString() });
    } catch (err) {
        if (err instanceof BusyError) {
            // Stay due; try again next tick. Log at most once a minute per schedule.
            if (Date.now() - (lastBusyLog.get(key) || 0) > 60_000) {
                lastBusyLog.set(key, Date.now());
                log.debug('Scheduled backup deferred, database busy', { databaseId: s.database_id, type: s.backup_type });
            }
            return;
        }
        const after = afterStartError(s, err, new Date());
        schedules.recordRun(s.database_id, s.backup_type, { ranAt: ranAt.toISOString(), status: after.status, nextRunAt: after.nextRunAt.toISOString() });
        if (after.failed) {
            log.warn('Scheduled backup could not start', { databaseId: s.database_id, type: s.backup_type, error: err.message });
            publish('backup.failed', { databaseId: s.database_id, type: s.backup_type, error: err.message });
        }
    } finally {
        inflight.delete(key);
        publish('database.changed', { databaseId: s.database_id });
    }
}

/**
 * What a schedule records when its backup could not start.
 * - The type does not apply right now (err.notApplicable): a neutral status,
 *   and the next regular run.
 * - Anything else (primary unreachable, database offline ...): the health and
 *   alert machinery reports those conditions; here the failure is recorded and
 *   retried soon.
 */
export function afterStartError(s, err, now) {
    if (err.notApplicable) return { failed: false, status: err.skipStatus || 'skipped', nextRunAt: nextRun(s, now) };
    return {
        failed: true,
        status: `failed: ${err.message}`,
        nextRunAt: new Date(Math.min(nextRun(s, now).getTime(), now.getTime() + RETRY_AFTER_FAILURE_MS)),
    };
}

export function tick(now = new Date()) {
    for (const s of schedules.due(now)) {
        const key = `${s.database_id}:${s.backup_type}`;
        if (inflight.has(key)) continue;
        if (!databases.primaryOf(s.database_id)) continue;
        if (pendingDrop(s.database_id)) continue; // gone from its server; stays due until it is back or no longer managed
        if (!s.next_run_at) {
            schedules.setNextRun(s.database_id, s.backup_type, nextRun(s, now).toISOString());
            continue;
        }
        runOne(s);
    }
}

export function start() {
    if (timer) return;
    timer = setInterval(() => {
        try {
            tick();
        } catch (err) {
            log.error('Scheduler tick failed', { err });
        }
    }, TICK_MS);
    timer.unref?.();
}

export function stop() {
    clearInterval(timer);
    timer = null;
}

export function inflightCount() {
    return inflight.size;
}
