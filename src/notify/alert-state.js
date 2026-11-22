// The alert dedupe state machine and message formatting. Pure functions (no
// database, no clock) so they can be unit tested; notify/alerts.js feeds them.
//
// Per condition key:
//   present for confirmMs        -> active, "new" notice
//   active, notice not delivered -> "new" notice again (retry)
//   active, reminder interval up -> "reminder" notice
//   absent for resolveMs         -> resolved, "resolved" notice (only if the
//                                   "new" notice had been delivered); kinds in
//                                   instantKinds resolve at once (a person
//                                   cleared them, so they cannot flap), and so
//                                   do keys in clearedKeys (a check has just
//                                   shown them fixed)
//   resolved, notice not yet delivered -> "resolved" notice again (retry)
// A notice counts as delivered when the caller records last_notified_at;
// a pending resolved notice is last_notified_at < resolved_at.

/** In-memory debounce state, owned by the caller. */
export function createMemo() {
    return { presentSince: new Map(), absentSince: new Map() };
}

const ms = (iso) => (iso ? new Date(iso).getTime() : null);

/**
 * @param {object} a
 * @param {Map<string, object>} a.conditions key -> { key, kind, severity, message, databaseId, serverId, link, confirmMs? }
 * @param {Map<string, object>} a.rows       key -> notification_state row
 * @param {{presentSince: Map, absentSince: Map}} a.memo  mutated
 * @param {number} a.now  epoch ms
 * @param {Set<string>} [a.instantKinds]  kinds that resolve without the resolve debounce
 * @param {Set<string>} [a.clearedKeys]   condition keys a check has just shown to be fixed: they resolve without the debounce too
 * @returns {{ writes: object[], notices: object[] }}
 */
export function decide({ conditions, rows, memo, now, reminderMs, confirmMs, resolveMs, instantKinds = new Set(), clearedKeys = new Set() }) {
    const writes = [];
    const notices = [];
    const iso = (t) => new Date(t).toISOString();

    for (const c of conditions.values()) {
        memo.absentSince.delete(c.key);
        const row = rows.get(c.key);
        if (row?.status === 'active') {
            if (row.message !== c.message || row.severity !== c.severity) {
                writes.push({ ...row, message: c.message, severity: c.severity, kind: c.kind, database_id: c.databaseId ?? null, server_id: c.serverId ?? null });
            }
            const last = ms(row.last_notified_at);
            if (last === null) notices.push(notice('new', c, row.first_seen_at));
            else if (reminderMs > 0 && now - last >= reminderMs) notices.push(notice('reminder', c, row.first_seen_at));
            continue;
        }
        const since = memo.presentSince.get(c.key) ?? now;
        memo.presentSince.set(c.key, since);
        if (now - since < (c.confirmMs ?? confirmMs)) continue;
        memo.presentSince.delete(c.key);
        const fresh = {
            key: c.key,
            kind: c.kind,
            severity: c.severity,
            status: 'active',
            message: c.message,
            first_seen_at: iso(since),
            last_notified_at: null,
            resolved_at: null,
            database_id: c.databaseId ?? null,
            server_id: c.serverId ?? null,
        };
        writes.push(fresh);
        notices.push(notice('new', c, fresh.first_seen_at));
    }

    for (const key of memo.presentSince.keys()) {
        if (!conditions.has(key)) memo.presentSince.delete(key);
    }

    for (const row of rows.values()) {
        if (conditions.has(row.key)) continue;
        if (row.status === 'active') {
            const since = memo.absentSince.get(row.key) ?? now;
            memo.absentSince.set(row.key, since);
            if (now - since < (instantKinds.has(row.kind) || clearedKeys.has(row.key) ? 0 : resolveMs)) continue;
            memo.absentSince.delete(row.key);
            const resolved = { ...row, status: 'resolved', resolved_at: iso(now) };
            writes.push(resolved);
            if (row.last_notified_at) notices.push(notice('resolved', fromRow(row), row.first_seen_at, resolved.resolved_at));
        } else if (row.last_notified_at && ms(row.last_notified_at) < ms(row.resolved_at)) {
            notices.push(notice('resolved', fromRow(row), row.first_seen_at, row.resolved_at));
        }
    }
    return { writes, notices };
}

function fromRow(r) {
    return { key: r.key, kind: r.kind, severity: r.severity, message: r.message, databaseId: r.database_id, serverId: r.server_id, link: null };
}

function notice(type, c, firstSeenAt, resolvedAt = null) {
    return { type, key: c.key, kind: c.kind, severity: c.severity, message: c.message, link: c.link ?? null, databaseId: c.databaseId ?? null, serverId: c.serverId ?? null, firstSeenAt, resolvedAt };
}

export function formatDuration(seconds) {
    if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 86400) {
        const h = Math.floor(seconds / 3600);
        const m = Math.round((seconds % 3600) / 60);
        return m ? `${h} h ${m} min` : `${h} h`;
    }
    return `${(seconds / 86400).toFixed(1)} days`;
}

const ORDER = { new: 0, reminder: 1, resolved: 2 };
const MAX_MESSAGE = 1024;

/**
 * One push message for all notices of one evaluation, so an outage that
 * trips several conditions at once arrives as one notification.
 */
export function formatBatch(notices, { publicUrl, now }) {
    const sorted = [...notices].sort((a, b) => ORDER[a.type] - ORDER[b.type] || (a.severity === 'error' ? -1 : 0) - (b.severity === 'error' ? -1 : 0));
    const age = (iso) => formatDuration((now - ms(iso)) / 1000);
    const line = (n) => {
        if (n.type === 'new') return `${n.severity === 'error' ? 'ERROR' : 'WARNING'}: ${n.message}`;
        if (n.type === 'reminder') return `STILL ACTIVE (${age(n.firstSeenAt)}): ${n.message}`;
        return `RESOLVED (after ${formatDuration((ms(n.resolvedAt) - ms(n.firstSeenAt)) / 1000)}): ${n.message}`;
    };
    const lines = [];
    let used = 0;
    for (let i = 0; i < sorted.length; i++) {
        const l = line(sorted[i]);
        // Keep room for the "… and N more" line.
        if (used + l.length + 1 > MAX_MESSAGE - 20 && lines.length) {
            lines.push(`… and ${sorted.length - i} more`);
            break;
        }
        lines.push(l);
        used += l.length + 1;
    }

    const count = (t) => sorted.filter((n) => n.type === t).length;
    let title;
    if (sorted.length === 1) {
        const n = sorted[0];
        title = n.type === 'new' ? (n.severity === 'error' ? 'Mostly-On: error' : 'Mostly-On: warning') : n.type === 'reminder' ? 'Mostly-On: still active' : 'Mostly-On: resolved';
    } else {
        const parts = [];
        if (count('new')) parts.push(`${count('new')} new`);
        if (count('reminder')) parts.push(`${count('reminder')} still active`);
        if (count('resolved')) parts.push(`${count('resolved')} resolved`);
        title = `Mostly-On: ${parts.join(', ')}`;
    }
    // Resolved-only batches arrive quietly; anything still wrong at normal priority.
    const priority = count('new') || count('reminder') ? 0 : -1;
    const url = sorted.length === 1 && sorted[0].link ? sorted[0].link : publicUrl;
    return { title, message: lines.join('\n'), priority, url, urlTitle: 'Open Mostly-On' };
}
