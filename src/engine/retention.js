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
import * as P from '../sql/privileged.js';
import { sqlErrorText } from '../sql/pool.js';
import { translatePath } from '../paths.js';
import { pathOpts } from './context.js';
import { retentionPlan } from './chain.js';
import { tryAcquire } from './locks.js';
import { publish } from '../bus.js';
import { checkRetention, effectiveRetention, globalRetention, safeRetention } from './retention-rules.js';
import { log } from '../log.js';

let timer = null;
let lastHistoryPurge = 0;

/** Files referenced by unfinished operations (e.g. a seed restoring a FULL). */
function filesInUse() {
    const ids = new Set();
    for (const op of ops.unfinished()) {
        for (const k of ['fileId', 'fullFileId', 'diffFileId', 'tailFileId', 'safetyFileId', 'freshLogFileId']) if (op.ctx[k]) ids.add(op.ctx[k]);
        for (const id of op.ctx.planFileIds ?? []) ids.add(id);
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
const warnedInconsistent = new Set();

/**
 * The database's effective retention (its own values, else the global ones).
 * FULL is never shorter than DIFF or LOG: a stored mismatch (older catalogs)
 * is corrected here and reported once.
 */
function retentionDaysFor(db) {
    const effective = effectiveRetention(databases.get(db.id) ?? db, globalRetention(settings.all()));
    const problem = checkRetention(effective);
    if (problem && !warnedInconsistent.has(db.id)) {
        warnedInconsistent.add(db.id);
        events.add('warn', 'retention', `${databases.label(db)}: ${problem} Mostly-On keeps FULL backups ${Math.max(effective.diff, effective.log)} days instead until you fix the retention settings.`, { databaseId: db.id });
    }
    const safe = safeRetention(effective);
    return { FULL: safe.full, DIFF: safe.diff, LOG: safe.log };
}

/** dropped: a database no longer managed because it was dropped on its server; its files go once past retention, newest ones too. */
export function applyToDatabase(db, { dryRun = false, dropped = false } = {}) {
    const result = { database: databases.label(db), databaseId: db.id, deleted: [], kept: 0, blocked: null, errors: [], protected: [] };
    const release = tryAcquire(db.id, 'retention');
    if (!release) {
        result.blocked = 'skipped: a failover, reinitialization or new secondary is in progress';
        return result;
    }
    try {
        const files = backups.present(db.id);
        const plan = retentionPlan({
            files,
            secondaries: databases.replicas(db.id),
            retentionDays: retentionDaysFor(db),
            now: new Date(),
            extraProtected: filesInUse(),
            lineage: forks.lineage(db.id),
            dropped,
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
            await P.run(s.id, P.purgeBackupHistory({ keepDays: keep }), { timeoutMs: 600_000 });
            events.add('info', 'retention', `Removed backup history older than ${keep} days from msdb on ${s.name}`, { serverId: s.id });
        } catch (err) {
            events.add('warn', 'retention', `Could not remove old backup history from msdb on ${s.name}: ${sqlErrorText(err)}`, { serverId: s.id });
        }
    }
}

/** actor: the user who started this run by hand (null for the regular runs). */
export async function runAll({ dryRun = false, actor = null } = {}) {
    const results = [];
    const dropped = new Set(databases.listDropped().map((d) => d.id));
    for (const db of [...databases.list(), ...databases.listDropped()]) {
        const r = applyToDatabase(db, { dryRun, dropped: dropped.has(db.id) });
        results.push(r);
        if (!dryRun && r.deleted.length) {
            events.add('info', 'retention', `Retention removed ${r.deleted.length} backup file(s) of ${databases.label(db)}`, {
                databaseId: db.id,
                data: { files: r.deleted.map((d) => d.rel_path) },
                actor,
            });
            publish('database.changed', { databaseId: db.id });
            if (dropped.has(db.id) && !backups.present(db.id).length) {
                events.add('info', 'retention', `The last backup files of ${databases.label(db)}, which was dropped, are gone (retention).`, { databaseId: db.id });
            }
        }
        for (const e of r.errors) events.add('error', 'retention', `Retention could not delete a file of ${databases.label(db)}: ${e}`, { databaseId: db.id });
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
