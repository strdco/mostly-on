// Retention rules shared by the API, the retention engine and the tests (pure).
//
// A DIFF or LOG backup is useless once the FULL it builds on is gone, so FULL
// backups must be kept at least as long as DIFF and LOG backups. (DIFF versus
// LOG needs no rule: logs can build on the FULL directly.)

/** Plain-language problem with a set of retention days, or null. */
export function checkRetention({ full, diff, log }) {
    if (full < log) return `FULL backups must be kept at least as long as LOG backups (${log} days), or the oldest log backups can't be restored.`;
    if (full < diff) return `FULL backups must be kept at least as long as DIFF backups (${diff} days), or the oldest DIFF backups can't be restored.`;
    return null;
}

/** The global retention days from the settings object. */
export function globalRetention(settings) {
    return { full: settings['retention.full_days'], diff: settings['retention.diff_days'], log: settings['retention.log_days'] };
}

/** A database's retention: its own value where it has one, else the global one. */
export function effectiveRetention(db, globals) {
    return {
        full: db?.retention_full_days ?? globals.full,
        diff: db?.retention_diff_days ?? globals.diff,
        log: db?.retention_log_days ?? globals.log,
    };
}

/**
 * Checks the global values and every database's effective values; returns the
 * first problem, naming the database it concerns, or null.
 */
export function checkAllRetention(globals, dbs) {
    const g = checkRetention(globals);
    if (g) return g;
    for (const db of dbs) {
        const p = checkRetention(effectiveRetention(db, globals));
        if (p) return `${db.name}: ${p} Change ${db.name}'s own retention first (on its page).`;
    }
    return null;
}

/** What retention actually uses: never a FULL shorter than the DIFF or LOG it would orphan. */
export function safeRetention(r) {
    return { ...r, full: Math.max(r.full, r.diff, r.log) };
}
