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

/**
 * Picks the next log backup a secondary at `position` must restore.
 *
 *   { status: 'restore', file }      the log whose range covers the position
 *   { status: 'caught_up' }          no log covers it and no later log exists
 *   { status: 'broken', reason }     a later log exists but the one in between
 *                                    is not in the catalog, or the file needed
 *                                    is missing/deleted: never guess
 *
 * @param {{files:object[], position:string, forkGuid?:string|null}} p
 *   files: catalog rows of the database (any file_status)
 */
export function nextLog({ files, position, forkGuid = null }) {
    const logs = files.filter((f) => f.type === 'LOG' && f.first_lsn && f.last_lsn);
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
        return { status: 'broken', reason: `${candidates.length} log backups cover LSN ${position} (${candidates.map((f) => f.rel_path).join(', ')}); refusing to guess` };
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
        reason: `No log backup covers LSN ${position}; the next one in the catalog (${next.rel_path}) starts at LSN ${next.first_lsn}. A log backup is missing from the chain (taken by another tool?)`,
    };
}

/**
 * Shipping lag of a secondary at `position`.
 *   files:        LOG backups with last_lsn > position (not yet restored)
 *   lastRestored: the catalog file ending at the position (LOG preferred),
 *                 i.e. the last backup the secondary has applied
 *   seconds:      now minus that file's backup_finish
 */
export function lag({ files, position, now = new Date() }) {
    if (!position) return { files: null, seconds: null, lastRestored: null };
    const logs = files.filter((f) => f.type === 'LOG' && f.last_lsn && f.file_status !== 'deleted');
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
 * Logs between a base position and the newest log, checked for gaps.
 * Returns null if the chain from `position` to the newest log is complete,
 * otherwise a description of the gap.
 */
export function chainGap(files, position) {
    let pos = position;
    for (let i = 0; i < 100_000; i++) {
        const next = nextLog({ files, position: pos });
        if (next.status === 'caught_up') return null;
        if (next.status === 'broken') return next.reason;
        pos = next.file.last_lsn;
    }
    return 'Log chain is too long to verify';
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
export function retentionPlan({ files, secondaries, retentionDays, now, extraProtected = new Set() }) {
    const present = files.filter((f) => f.file_status === 'present');
    const protectedIds = new Map();
    const protect = (f, why) => {
        if (!protectedIds.has(f.id)) protectedIds.set(f.id, why);
    };

    const active = secondaries.filter((s) => s.role === 'secondary' && s.chain_state !== 'needs_reseed');
    const unknown = active.find((s) => !s.position_lsn && s.chain_state !== 'seeding');
    if (unknown) return { deletable: [], protectedIds, blocked: `secondary on server ${unknown.server_id} has no known restore position` };

    const base = newestBase(present);
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
