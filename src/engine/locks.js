// Per-database lock manager (in memory; the controller is a single process).
//
// Lock kinds and what they conflict with:
//   exclusive     everything (seed, reseed, failovers)
//   full, diff    each other and themselves
//   log           itself
//   restore:<id>  itself (one restore stream per secondary)
//   retention     exclusive and itself
// A LOG backup may run during a FULL or DIFF; restores on secondaries may run
// while the primary is backing up.

export class BusyError extends Error {
    constructor(databaseId, kind, holders) {
        super(`Database ${databaseId} is busy (${holders.join(', ')}); cannot start ${kind}`);
        this.status = 409;
        this.holders = holders;
    }
}

const held = new Map(); // databaseId -> Map(token -> kind)
const exclusiveWaiters = new Map(); // databaseId -> number of acquire('exclusive') calls waiting
let nextToken = 1;

export function conflicts(a, b) {
    if (a === 'exclusive' || b === 'exclusive') return true;
    const fd = (k) => k === 'full' || k === 'diff';
    if (fd(a) && fd(b)) return true;
    if (a === 'log' && b === 'log') return true;
    if (a === 'retention' && b === 'retention') return true;
    if (a.startsWith('restore:') && a === b) return true;
    return false;
}

export function holders(databaseId) {
    return [...(held.get(databaseId)?.values() || [])];
}

/**
 * Returns a release function, or null if a conflicting lock is held. While a
 * failover waits for the exclusive lock, no new locks are handed out on that
 * database, so a stream of short restore passes cannot starve it.
 */
export function tryAcquire(databaseId, kind) {
    if (kind !== 'exclusive' && exclusiveWaiters.get(databaseId)) return null;
    const m = held.get(databaseId) || new Map();
    for (const k of m.values()) if (conflicts(kind, k)) return null;
    const token = nextToken++;
    m.set(token, kind);
    held.set(databaseId, m);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        m.delete(token);
        if (!m.size) held.delete(databaseId);
    };
}

/** Like tryAcquire but waits up to timeoutMs; throws BusyError on timeout. */
export async function acquire(databaseId, kind, { timeoutMs = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const exclusive = kind === 'exclusive';
    if (exclusive) exclusiveWaiters.set(databaseId, (exclusiveWaiters.get(databaseId) || 0) + 1);
    try {
        for (;;) {
            const release = tryAcquire(databaseId, kind);
            if (release) return release;
            if (Date.now() >= deadline) throw new BusyError(databaseId, kind, holders(databaseId));
            await new Promise((r) => setTimeout(r, 250));
        }
    } finally {
        if (exclusive) {
            const n = exclusiveWaiters.get(databaseId) - 1;
            if (n > 0) exclusiveWaiters.set(databaseId, n);
            else exclusiveWaiters.delete(databaseId);
        }
    }
}

/** True while someone waits for the database's exclusive lock (long holders should yield). */
export function exclusiveWaiting(databaseId) {
    return !!exclusiveWaiters.get(databaseId);
}

/** Test helper. */
export function _reset() {
    held.clear();
    exclusiveWaiters.clear();
}
