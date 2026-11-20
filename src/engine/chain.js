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

/**
 * Decides which files retention may delete.
 *
 * Protected (never deleted):
 *  - the newest FULL, its newest DIFF and every LOG after that base (the
 *    newest restorable chain);
 *  - every LOG a secondary has not restored yet (last_lsn > its position);
 *  - DIVERGED safety backups;
 *  - anything in `extraProtected` (files in use by running operations).
 * If a non-diverged secondary has no known position, or no FULL exists,
 * nothing is deleted at all.
 *
 * @param {{files:object[], secondaries:{server_id:number, role:string, position_lsn:string|null}[],
 *          retentionDays:{FULL:number, DIFF:number, LOG:number}, now:Date, extraProtected?:Set<number>}} p
 * @returns {{deletable:object[], protectedIds:Map<number,string>, blocked:string|null}}
 */
export function retentionPlan({ files, secondaries, retentionDays, now, extraProtected = new Set() }) {
    const present = files.filter((f) => f.file_status === 'present');
    const protectedIds = new Map();
    const protect = (f, why) => {
        if (!protectedIds.has(f.id)) protectedIds.set(f.id, why);
    };

    const active = secondaries.filter((s) => s.role === 'secondary');
    const unknown = active.find((s) => !s.position_lsn);
    if (unknown) return { deletable: [], protectedIds, blocked: `secondary on server ${unknown.server_id} has no known restore position` };

    const base = newestBase(present);
    if (!base) return { deletable: [], protectedIds, blocked: 'no FULL backup on disk' };
    protect(base.full, 'newest FULL');
    if (base.diff) protect(base.diff, 'newest DIFF of the newest FULL');
    for (const f of present) {
        if (f.type === 'LOG' && L.gt(f.last_lsn, base.position)) protect(f, 'needed to restore the newest chain');
    }

    for (const s of active) {
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
