// Backup retention in the dashboard: the same rule the server enforces
// (src/engine/retention-rules.js), checked before saving so the problem is
// shown next to the fields. The server stays the authority.

/** Plain-language problem with a set of retention days, or null. */
export function retentionProblem({ full, diff, log }) {
    if (full < log) return `FULL backups must be kept at least as long as LOG backups (${log} days), or the oldest log backups can't be restored.`;
    if (full < diff) return `FULL backups must be kept at least as long as DIFF backups (${diff} days), or the oldest DIFF backups can't be restored.`;
    return null;
}
