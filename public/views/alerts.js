// Alerts: what is wrong right now, and what was wrong recently.
import { h, clear, dataTable, badge, timeTag } from '../dom.js';
import { get } from '../api.js';
import { formatDuration } from './overview.js';
import { resolveOperation } from './operations.js';

const KIND_LABEL = {
    server_unreachable: 'Server unreachable',
    db_state: 'Database state',
    chain: 'Shipping stopped',
    lag: 'Lag',
    restore_failed: 'Restore failed',
    backup_failed: 'Backup failed',
    foreign_backup: 'Backup taken outside Mostly-On',
    diverged: 'Out-of-sync copy',
    split_brain: 'Split-brain risk',
    operation: 'Operation',
    setup: 'Server setup',
};

const since = (iso) => formatDuration(Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)));

/**
 * What the person can do about an alert. Alerts are never dismissed by hand: each
 * clears once its cause is gone. A failed operation's cause goes away when it is
 * marked resolved (or resumed), so that alert carries the button.
 */
function alertAction(a, { compact = false } = {}) {
    if (a.kind === 'operation') {
        const id = Number(a.key.split(':')[1]);
        return h('button', { type: 'button', class: compact ? 'link' : null, onclick: () => resolveOperation({ id }) }, compact ? `Mark operation #${id} resolved…` : 'Mark resolved…');
    }
    if (compact) return null;
    return h('span.small.muted', a.kind === 'foreign_backup' ? 'Clears when you acknowledge it on the database page.' : 'Clears by itself once the problem is fixed.');
}

function target(a) {
    if (a.kind === 'operation') return h('a', { href: '#/operations' }, 'Operations');
    if (a.database_id) return h('a', { href: `#/databases/${a.database_id}` }, 'Database');
    if (a.server_id) return h('a', { href: `#/servers/${a.server_id}` }, 'Server');
    return '';
}

/** Callout for the overview: active alerts, or nothing. */
export function activeAlertsCallout(alerts) {
    const active = alerts.filter((a) => a.status === 'active');
    if (!active.length) return null;
    const errors = active.some((a) => a.severity === 'error');
    return h(
        errors ? 'div.callout.err' : 'div.callout.warn',
        h('strong', `${active.length} active alert${active.length === 1 ? '' : 's'}. `),
        h('a', { href: '#/alerts' }, 'See all alerts'),
        h(
            'ul',
            active.map((a) =>
                h(
                    'li',
                    badge(a.severity === 'error' ? 'error' : 'warning', a.severity === 'error' ? 'err' : 'warn'),
                    ' ',
                    a.message,
                    ' ',
                    h('span.muted', `(for ${since(a.first_seen_at)})`),
                    a.kind === 'operation' ? [' ', alertAction(a, { compact: true })] : null,
                ),
            ),
        ),
    );
}

export function alertsView() {
    let box;
    let timer;

    async function load() {
        const [alerts, delivery] = await Promise.all([get('/api/alerts'), get('/api/notifications')]);
        const active = alerts.filter((a) => a.status === 'active');
        const resolved = alerts.filter((a) => a.status === 'resolved');
        const configured = delivery.channels.some((c) => c.configured);
        clear(box).append(
            ...[
                configured
                    ? delivery.lastError
                        ? h('div.callout.err', h('strong', 'Notifications are failing. '), delivery.lastError, delivery.nextAttemptAt ? [' Next attempt ', timeTag(delivery.nextAttemptAt), '.'] : '')
                        : null
                    : h('div.callout.warn', 'No notification channel is configured, so alerts are only shown here. See ', h('a', { href: '#/settings' }, 'Settings'), '.'),
                dataTable({
                    caption: 'Active alerts',
                    rows: active,
                    empty: 'Nothing is wrong right now.',
                    columns: [
                        { label: 'Severity', cell: (a) => badge(a.severity === 'error' ? 'error' : 'warning', a.severity === 'error' ? 'err' : 'warn') },
                        { label: 'Alert', header: true, cell: (a) => [h('div.small.muted', KIND_LABEL[a.kind] || a.kind), a.message] },
                        { label: 'Since', cell: (a) => [timeTag(a.first_seen_at), h('div.small.muted', since(a.first_seen_at))] },
                        { label: 'Last notified', cell: (a) => (a.last_notified_at ? timeTag(a.last_notified_at) : h('span.muted', 'not sent')) },
                        { label: 'Go to', cell: target },
                        { label: 'What to do', cell: (a) => alertAction(a) },
                    ],
                }),
                h('h2', 'Resolved'),
                dataTable({
                    caption: 'Resolved alerts (kept 90 days)',
                    rows: resolved,
                    empty: 'No resolved alerts.',
                    columns: [
                        { label: 'Alert', header: true, cell: (a) => [h('div.small.muted', KIND_LABEL[a.kind] || a.kind), a.message] },
                        { label: 'Started', cell: (a) => timeTag(a.first_seen_at) },
                        { label: 'Resolved', cell: (a) => timeTag(a.resolved_at) },
                        {
                            label: 'Lasted',
                            num: true,
                            cell: (a) => formatDuration(Math.round((new Date(a.resolved_at) - new Date(a.first_seen_at)) / 1000)),
                        },
                    ],
                }),
            ].filter((x) => x !== null),
        );
    }

    return {
        async render(el) {
            box = h('div');
            el.append(h('h1', 'Alerts'), box);
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'alert.changed') return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 400);
        },
    };
}
