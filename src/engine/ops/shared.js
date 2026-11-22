// Steps and helpers shared by the operations that bring a copy online and start
// a new branch of the database's history: failovers (failover.js) and
// point-in-time rollbacks (pitr.js).
import * as databases from '../../store/repos/databases.js';
import * as backups from '../../store/repos/backups.js';
import * as forks from '../../store/repos/forks.js';
import * as events from '../../store/repos/events.js';
import * as inspect from '../../sql/inspect.js';
import { sqlErrorText } from '../../sql/pool.js';
import { acquire, BusyError } from '../locks.js';
import { nudgeDatabase } from '../restore-loop.js';
import { startBackup, recordBackupFile } from '../backup.js';
import { translatePath } from '../../paths.js';
import { pathOpts } from '../context.js';

export const LOCK_WAIT_MS = 30 * 60_000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fail(status, message, details) {
    return Object.assign(new Error(message), { status, expose: true, details });
}

export function errText(err) {
    return err.number || err.code ? sqlErrorText(err) : err.message;
}

/** The exclusive lock, shared by the steps of one run (and released before first_log). */
export function lockHolder(db) {
    let release = null;
    return {
        async acquire(ctx) {
            if (release) return;
            ctx?.progress('Waiting for running backups and restores to finish');
            release = await acquire(db.id, 'exclusive', { timeoutMs: LOCK_WAIT_MS });
        },
        release() {
            release?.();
            release = null;
        },
    };
}

/** Records the fork the recovered copy is on as a child of the lineage tip. */
export async function recordFork(db, server, ctx) {
    const live = await inspect.dbRestoreState(server.id, db.name);
    if (!live?.recoveryForkGuid) throw new Error(`${server.name} reports no recovery fork for ${db.name}`);
    if (ctx.state.oldForkGuid) forks.ensureRoot(db.id, ctx.state.oldForkGuid);
    const tip = forks.tip(db.id);
    if (tip === live.recoveryForkGuid) return 'The new branch of the database history is already recorded';
    forks.addChild(db.id, { forkGuid: live.recoveryForkGuid, parentForkGuid: tip, forkPointLsn: live.forkPointLsn, operationId: ctx.op.id });
    return `${db.name} continues on a new branch of its history (recovery fork ${live.recoveryForkGuid}, from LSN ${live.forkPointLsn})`;
}

/**
 * Says in words who owns a recovered database (row: the result of the recover
 * helper). With record, also stores it as the managed database's owner.
 */
export function ownerNote(db, target, owner, row, { name = db.name, category = 'failover', record = true, whose = 'the owner on the old primary' } = {}) {
    if (!row) return 'owner unchanged';
    // 'kept': the database was not restored by Mostly-On (a rollback WITH REPLACE
    // keeps the owner), so the helper left the owner, and what is known about it, alone.
    if (row.matched_by === 'kept') return `owner: ${row.owner_name} (unchanged)`;
    if (record) databases.noteRecoveredOwner(db.id, { ownerName: row.owner_name, matchedBy: row.matched_by });
    const wanted = owner?.owner_name;
    if (row.matched_by === 'sid' || row.matched_by === 'name') return `owner: ${row.owner_name}`;
    if (row.matched_by === 'fallback') {
        const why = wanted ? `${wanted}, ${whose}, has no login on ${target.name}` : 'the original owner is not known';
        events.add('info', category, `${name} on ${target.name} is now owned by ${row.owner_name}: ${why}. To restore the owner, create that login on ${target.name} and run ALTER AUTHORIZATION ON DATABASE::[${name}] TO [${wanted ?? 'login'}];`, {
            databaseId: db.id,
            serverId: target.id,
        });
        return `owner: ${row.owner_name} (${why})`;
    }
    return `owner unchanged (${row.note || 'could not be set'})`;
}

/**
 * The first LOG backup after a copy was recovered: releases the lock first. It
 * never fails the operation (the LOG schedule takes the next one).
 */
export function firstLogStep(db, target, holder, { trigger = 'failover', what = 'failover', category = 'failover' } = {}) {
    return {
        name: 'first_log',
        label: `First LOG backup on the new primary ${target.name}`,
        check: (ctx) => (ctx.state.postLogFileId ? `Backup #${ctx.state.postLogFileId} already taken` : false),
        run: async (ctx) => {
            holder.release();
            nudgeDatabase(db.id);
            let started;
            try {
                for (let i = 0; ; i++) {
                    try {
                        started = await startBackup(db.id, 'LOG', { trigger, parentId: ctx.op.id });
                        break;
                    } catch (err) {
                        if (err instanceof BusyError && i < 24) {
                            await sleep(5000);
                            continue;
                        }
                        throw err;
                    }
                }
            } catch (err) {
                return `Could not start it (${err.message}). The ${what} itself is complete; the LOG schedule takes the next backup.`;
            }
            const { operation, file } = await started.done;
            if (operation.status !== 'succeeded' || !file) {
                return `It failed (${operation.error}). The ${what} itself is complete; the LOG schedule takes the next backup.`;
            }
            ctx.save({ postLogFileId: file.id });
            return `${started.type} backup #${file.id} ${file.rel_path}${await verifyForkCrossing(db, target, file, { what, category })}`;
        },
    };
}

/** Cross-checks msdb's fork GUIDs of a log that crosses a fork with RESTORE HEADERONLY. */
async function verifyForkCrossing(db, server, file, { what, category }) {
    if (!file.first_recovery_fork_guid || file.first_recovery_fork_guid === file.recovery_fork_guid) return '';
    try {
        const [h] = await inspect.headerOnly(server.id, translatePath(file.rel_path, server, pathOpts('rel', 'sql')));
        if (h && h.firstRecoveryForkGuid === file.first_recovery_fork_guid && h.recoveryForkGuid === file.recovery_fork_guid) {
            return ' (checked: the secondaries can continue from it)';
        }
        events.add('error', category, `The first log backup after the ${what} (${file.rel_path}) may not be usable by the secondaries: RESTORE HEADERONLY and msdb disagree about which branch of history it belongs to.`, {
            databaseId: db.id,
            serverId: server.id,
            data: { msdb: { first: file.first_recovery_fork_guid, last: file.recovery_fork_guid }, header: h },
        });
        return ' (WARNING: RESTORE HEADERONLY disagrees with msdb about the recovery forks)';
    } catch (err) {
        return ` (could not double-check it with RESTORE HEADERONLY: ${errText(err)})`;
    }
}

/** Catalogs a tail-log backup taken by an operation (once). */
export async function catalogTail(db, server, relPath, opId) {
    const existing = backups.byRelPath(relPath);
    if (existing) return existing;
    const bs = await inspect.backupsetByPath(server.id, db.name, translatePath(relPath, server, pathOpts('rel', 'sql')));
    if (!bs) return null;
    return recordBackupFile({ db, server, bs, relPath, operationId: opId, isTail: true });
}
