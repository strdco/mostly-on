// Pure backup-chain logic (no I/O), shared by retention and shipping.
// All LSNs are decimal strings compared with lsn.js.
import * as L from '../lsn.js';

const DAY_MS = 86400_000;

/**
 * The newest restorable base: newest FULL on disk, plus its newest DIFF.
 * Returns { full, diff, position } where position is the LSN a restore of the
 * base leaves the database at (logs from there on are needed), or null.
 */
export function newestBase(files) {
    const fulls = files.filter((f) => f.type === 'FULL' && f.file_status === 'present' && f.last_lsn);
    if (!fulls.length) return null;
    const full = fulls.reduce((a, b) => (newer(b, a) ? b : a));
    const diffs = files.filter(
        (f) => f.type === 'DIFF' && f.file_status === 'present' && f.differential_base_guid && f.differential_base_guid === full.backup_set_uuid,
    );
    const diff = diffs.length ? diffs.reduce((a, b) => (L.gt(b.last_lsn, a.last_lsn) ? b : a)) : null;
    return { full, diff, position: diff ? diff.last_lsn : full.last_lsn };
}

function newer(a, b) {
    if (a.backup_finish !== b.backup_finish) return a.backup_finish > b.backup_finish;
    return a.id > b.id;
}

const covers = (f, lsn) => L.lte(f.first_lsn, lsn) && L.lt(lsn, f.last_lsn);

// --- recovery forks --------------------------------------------------------------
//
// Every RESTORE ... WITH RECOVERY starts a new recovery fork at a fork point
// (the LSN the database was recovered at). The active lineage is the list of
// forks from the root to the current primary's fork, each with the LSN where
// it branched off its parent: [{fork_guid, fork_point_lsn}], root first.
//
// A backup is on the lineage when its last fork is on it and, if that fork is
// an ancestor, the backup ends at or before the point where the lineage
// branched away (anything later on that fork was abandoned, e.g. logs the old
// primary wrote after the last log that reached the new primary).

/** Is a backup file on the active lineage? (true when no lineage is known) */
export function onLineage(file, lineage) {
    if (!lineage?.length || !file.recovery_fork_guid) return true;
    const idx = lineage.findIndex((f) => f.fork_guid === file.recovery_fork_guid);
    if (idx < 0) return false;
    if (file.first_recovery_fork_guid && file.first_recovery_fork_guid !== file.recovery_fork_guid) {
        // A log that crosses a fork: it must cross exactly at the lineage's fork point.
        if (idx === 0 || lineage[idx - 1].fork_guid !== file.first_recovery_fork_guid) return false;
    }
    if (idx < lineage.length - 1) {
        const branch = lineage[idx + 1].fork_point_lsn;
        if (branch && file.last_lsn && L.gt(file.last_lsn, branch)) return false;
    }
    return true;
}

/**
 * Can a copy at (position, forkGuid) still follow the active lineage?
 * Returns null if it can, otherwise the reason it needs a reseed.
 */
export function lineageProblem({ position, forkGuid, lineage }) {
    if (!lineage?.length || !forkGuid || !position) return null;
    const idx = lineage.findIndex((f) => f.fork_guid === forkGuid);
    if (idx < 0) return `it is on recovery fork ${forkGuid}, which is not on the current primary's recovery path`;
    if (idx < lineage.length - 1) {
        const branch = lineage[idx + 1].fork_point_lsn;
        if (branch && L.gt(position, branch)) {
            return `it already holds changes the current primary never had: it kept going past the point where the current primary took over (LSN ${branch})`;
        }
    }
    return null;
}

/**
 * Picks the next log backup a secondary at `position` must restore.
 *
 *   { status: 'restore', file }      the log whose range covers the position
 *   { status: 'caught_up' }          no log covers it and no later log exists
 *   { status: 'broken', reason }     a later log exists but the one in between
 *                                    is not in the catalog, or the file needed
 *                                    is missing/deleted: never guess
 *
 * Only logs on the active lineage are considered.
 *
 * @param {{files:object[], position:string, forkGuid?:string|null, lineage?:object[]|null}} p
 *   files: catalog rows of the database (any file_status)
 */
export function nextLog({ files, position, forkGuid = null, lineage = null }) {
    const logs = files.filter((f) => f.type === 'LOG' && f.first_lsn && f.last_lsn && onLineage(f, lineage));
    let candidates = logs.filter((f) => covers(f, position));
    if (candidates.length > 1 && forkGuid) {
        const sameFork = candidates.filter((f) => f.first_recovery_fork_guid === forkGuid);
        if (sameFork.length) candidates = sameFork;
    }
    if (candidates.length > 1) {
        const usable = candidates.filter((f) => f.file_status === 'present');
        if (usable.length === 1) candidates = usable;
    }
    if (candidates.length > 1) {
        return { status: 'broken', reason: `${candidates.length} different log backups could each be the next one to restore (${candidates.map((f) => f.rel_path).join(', ')}), so Mostly On does not guess (LSN ${position})` };
    }
    if (candidates.length === 1) {
        const file = candidates[0];
        if (file.file_status !== 'present') {
            return { status: 'broken', file, reason: `The next log backup ${file.rel_path} is ${file.file_status === 'deleted' ? 'deleted' : 'missing from disk'}` };
        }
        return { status: 'restore', file };
    }
    const later = logs.filter((f) => L.gt(f.last_lsn, position));
    if (!later.length) return { status: 'caught_up' };
    const next = later.reduce((a, b) => (L.lt(b.first_lsn, a.first_lsn) ? b : a));
    return {
        status: 'broken',
        reason: `A log backup is missing: the next one Mostly On knows about (${next.rel_path}) starts later than where this copy stopped. Was a log backup taken by another tool? (stopped at LSN ${position}, next starts at LSN ${next.first_lsn})`,
    };
}

/**
 * Shipping lag of a secondary at `position`.
 *   files:        LOG backups with last_lsn > position (not yet restored)
 *   lastRestored: the catalog file ending at the position (LOG preferred),
 *                 i.e. the last backup the secondary has applied
 *   seconds:      now minus that file's backup_finish
 */
export function lag({ files, position, now = new Date(), lineage = null }) {
    if (!position) return { files: null, seconds: null, lastRestored: null };
    const logs = files.filter((f) => f.type === 'LOG' && f.last_lsn && f.file_status !== 'deleted' && onLineage(f, lineage));
    const pending = logs.filter((f) => L.gt(f.last_lsn, position) && L.lt(f.first_lsn, f.last_lsn));
    const rank = { LOG: 3, DIFF: 2, FULL: 1 };
    const atPos = files
        .filter((f) => rank[f.type] && f.last_lsn && L.eq(f.last_lsn, position))
        .sort((a, b) => rank[b.type] - rank[a.type] || (b.backup_finish || '').localeCompare(a.backup_finish || ''));
    const lastRestored = atPos[0] || null;
    const finish = lastRestored?.backup_finish ? new Date(lastRestored.backup_finish).getTime() : null;
    return {
        files: pending.length,
        seconds: finish === null ? null : Math.max(0, Math.round((now.getTime() - finish) / 1000)),
        lastRestored: lastRestored ? { id: lastRestored.id, type: lastRestored.type, backup_finish: lastRestored.backup_finish } : null,
    };
}

/**
 * Walks the chain from `position` as far as the catalog allows.
 * Returns { position, lastFile, files, gap } where position is where a copy
 * would end up after restoring every reachable log, lastFile the last of
 * them (null if none) and gap the reason it stops early (null if it reaches
 * the newest log).
 */
export function reachable({ files, position, forkGuid = null, lineage = null }) {
    const logs = files.filter((f) => f.type === 'LOG' && f.first_lsn && f.last_lsn && onLineage(f, lineage));
    let pos = position;
    let fork = forkGuid;
    let lastFile = null;
    let count = 0;
    for (let i = 0; i < 100_000; i++) {
        const next = nextLog({ files: logs, position: pos, forkGuid: fork, lineage });
        if (next.status === 'caught_up') return { position: pos, lastFile, files: count, gap: null };
        if (next.status === 'broken') return { position: pos, lastFile, files: count, gap: next.reason };
        lastFile = next.file;
        pos = next.file.last_lsn;
        fork = next.file.recovery_fork_guid || fork;
        count++;
    }
    return { position: pos, lastFile, files: count, gap: 'Too many log backups to check' };
}

/**
 * Logs between a base position and the newest log, checked for gaps.
 * Returns null if the chain from `position` to the newest log is complete,
 * otherwise a description of the gap.
 */
export function chainGap(files, position, lineage = null) {
    return reachable({ files, position, lineage }).gap;
}

/** newestBase() restricted to backups on the active lineage. */
export function newestBaseOnLineage(files, lineage) {
    return newestBase(files.filter((f) => onLineage(f, lineage)));
}

/**
 * Decides which files retention may delete.
 *
 * Protected (never deleted):
 *  - the newest FULL, its newest DIFF and every LOG after that base (the
 *    newest restorable chain);
 *  - every LOG a secondary has not restored yet (last_lsn > its position);
 *  - DIVERGED safety backups;
 *  - anything in `extraProtected` (files in use by running operations).
 * If a secondary that is shipping (or broken) has no known position, or no
 * FULL exists, nothing is deleted at all. Secondaries that need a reseed do
 * not protect anything; a seeding secondary protects from its position once
 * it has one (its base files are protected through `extraProtected`).
 *
 * @param {{files:object[], secondaries:{server_id:number, role:string, chain_state?:string, position_lsn:string|null}[],
 *          retentionDays:{FULL:number, DIFF:number, LOG:number}, now:Date, extraProtected?:Set<number>}} p
 * @returns {{deletable:object[], protectedIds:Map<number,string>, blocked:string|null}}
 */
export function retentionPlan({ files, secondaries, retentionDays, now, extraProtected = new Set(), lineage = null }) {
    const present = files.filter((f) => f.file_status === 'present');
    const protectedIds = new Map();
    const protect = (f, why) => {
        if (!protectedIds.has(f.id)) protectedIds.set(f.id, why);
    };

    const active = secondaries.filter((s) => s.role === 'secondary' && s.chain_state !== 'needs_reseed');
    const unknown = active.find((s) => !s.position_lsn && s.chain_state !== 'seeding');
    if (unknown) return { deletable: [], protectedIds, blocked: `secondary on server ${unknown.server_id} has no known restore position` };

    const base = newestBaseOnLineage(present, lineage);
    if (!base) return { deletable: [], protectedIds, blocked: 'no FULL backup on disk' };
    protect(base.full, 'newest FULL');
    if (base.diff) protect(base.diff, 'newest DIFF of the newest FULL');
    for (const f of present) {
        if (f.type === 'LOG' && L.gt(f.last_lsn, base.position)) protect(f, 'needed to restore the newest chain');
    }

    for (const s of active) {
        if (!s.position_lsn) continue;
        for (const f of present) {
            if (f.type === 'LOG' && L.gt(f.last_lsn, s.position_lsn)) protect(f, `not yet restored on server ${s.server_id}`);
        }
    }

    for (const f of present) {
        if (f.type === 'DIVERGED') protect(f, 'safety backup of a diverged replica');
        if (extraProtected.has(f.id)) protect(f, 'in use by a running operation');
    }

    const deletable = present.filter((f) => {
        if (protectedIds.has(f.id)) return false;
        const days = retentionDays[f.type];
        if (days === undefined || days === null) return false;
        const finished = new Date(f.backup_finish || f.created_at).getTime();
        return now.getTime() - finished > days * DAY_MS;
    });
    return { deletable, protectedIds, blocked: null };
}
