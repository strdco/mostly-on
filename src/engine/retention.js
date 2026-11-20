// Retention: deletes old backup files from the shared volume under the rules
// in chain.retentionPlan(), purges routine operation records and, if enabled,
// old msdb backup history.
import fs from 'node:fs';
import path from 'node:path';
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as backups from '../store/repos/backups.js';
import * as forks from '../store/repos/forks.js';
import * as ops from '../store/repos/operations.js';
import * as events from '../store/repos/events.js';
import * as settings from '../store/repos/settings.js';
import * as health from './health.js';
import * as Q from '../sql/tsql.js';
import { query, T, sqlErrorText } from '../sql/pool.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { retentionPlan } from './chain.js';
import { tryAcquire } from './locks.js';
import { publish } from '../bus.js';
import { log } from '../log.js';

let timer = null;
let lastHistoryPurge = 0;

/** Files referenced by unfinished operations (e.g. a seed restoring a FULL). */
function filesInUse() {
    const ids = new Set();
    for (const op of ops.unfinished()) {
        for (const k of ['fileId', 'fullFileId', 'diffFileId', 'tailFileId', 'safetyFileId']) if (op.ctx[k]) ids.add(op.ctx[k]);
    }
    return ids;
}

function deleteFile(file) {
    const server = serversRepo.get(file.server_id);
    const abs = translatePath(file.rel_path, server, pathOpts('rel', 'controller'));
    const root = abs.slice(0, abs.length - file.rel_path.length).replace(/\/+$/, '') || '/';
    // Refuse to follow symlinks out of the backup root.
    const realRoot = fs.realpathSync(root);
    let realFile;
    try {
        realFile = fs.realpathSync(abs);
    } catch (err) {
        if (err.code === 'ENOENT') return 'missing';
        throw err;
    }
    if (!realFile.startsWith(realRoot + path.sep)) throw new Error(`Refusing to delete ${abs}: resolves outside the backup root`);
    fs.unlinkSync(realFile);
    return 'deleted';
}

/**
 * Applies retention to one database.
 * @returns {{database:string, deleted:object[], kept:number, blocked:string|null, errors:string[]}}
 */
export function applyToDatabase(db, { dryRun = false } = {}) {
    const result = { database: db.name, databaseId: db.id, deleted: [], kept: 0, blocked: null, errors: [], protected: [] };
    const release = tryAcquire(db.id, 'retention');
    if (!release) {
        result.blocked = 'database busy (seed or failover running)';
        return result;
    }
    try {
        const files = backups.present(db.id);
        const plan = retentionPlan({
            files,
            secondaries: databases.replicas(db.id),
            retentionDays: {
                FULL: settings.get('retention.full_days'),
                DIFF: settings.get('retention.diff_days'),
                LOG: settings.get('retention.log_days'),
            },
            now: new Date(),
            extraProtected: filesInUse(),
            lineage: forks.lineage(db.id),
        });
        result.blocked = plan.blocked;
        result.kept = files.length - plan.deletable.length;
        result.protected = [...plan.protectedIds].map(([id, why]) => ({ id, why }));
        for (const f of plan.deletable) {
            if (dryRun) {
                result.deleted.push({ id: f.id, rel_path: f.rel_path, type: f.type });
                continue;
            }
            try {
                const outcome = deleteFile(f);
                backups.markStatus(f.id, outcome);
                result.deleted.push({ id: f.id, rel_path: f.rel_path, type: f.type, outcome });
            } catch (err) {
                result.errors.push(`${f.rel_path}: ${err.message}`);
            }
        }
    } finally {
        release();
    }
    return result;
}

async function purgeMsdbHistory() {
    if (!settings.get('msdb_history.purge_enabled')) return;
    if (Date.now() - lastHistoryPurge < 86400_000) return;
    lastHistoryPurge = Date.now();
    const keep = settings.get('msdb_history.keep_days');
    for (const s of serversRepo.list().filter((x) => x.enabled && health.getHealth(x.id)?.ok)) {
        try {
            await query(s.id, Q.PURGE_BACKUP_HISTORY, { keep_days: T.int(keep) }, { timeoutMs: 600_000 });
            events.add('info', 'retention', `Purged msdb backup history older than ${keep} days on ${s.name}`, { serverId: s.id });
        } catch (err) {
            events.add('warn', 'retention', `Could not purge msdb backup history on ${s.name}: ${sqlErrorText(err)}`, { serverId: s.id });
        }
    }
}

export async function runAll({ dryRun = false } = {}) {
    const results = [];
    for (const db of databases.list()) {
        const r = applyToDatabase(db, { dryRun });
        results.push(r);
        if (!dryRun && r.deleted.length) {
            events.add('info', 'retention', `Retention removed ${r.deleted.length} backup file(s) of ${db.name}`, {
                databaseId: db.id,
                data: { files: r.deleted.map((d) => d.rel_path) },
            });
            publish('database.changed', { databaseId: db.id });
        }
        for (const e of r.errors) events.add('error', 'retention', `Retention could not delete a file of ${db.name}: ${e}`, { databaseId: db.id });
    }
    if (!dryRun) {
        const purged = ops.purgeRoutine(new Date(Date.now() - 14 * 86400_000).toISOString());
        if (purged) log.info('Purged routine backup operation records', { count: purged });
        await purgeMsdbHistory();
    }
    return results;
}

export function start() {
    const loop = async () => {
        try {
            if (settings.get('retention.enabled')) await runAll();
        } catch (err) {
            log.error('Retention run failed', { err });
        }
        timer = setTimeout(loop, settings.get('retention.interval_minutes') * 60_000);
        timer.unref?.();
    };
    // First run a few minutes after startup, once reconciliation and health are settled.
    timer = setTimeout(loop, 5 * 60_000);
    timer.unref?.();
}

export function stop() {
    clearTimeout(timer);
}
