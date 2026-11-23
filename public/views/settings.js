// Settings: notifications and alert rules, monitoring intervals, retention,
// default schedules and msdb history, each in its own card. Every card saves on
// its own; the server validates everything before storing.
import { h, clear, toast, formatTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { scheduleDialog, describeSchedule } from './schedule.js';
import { retentionProblem } from './retention.js';

/*
 * Card fields:
 *   { key, label, unit, min, max?, step?, hint? } a number, with its unit after the box
 *   { key, label, type: 'switch', hint? }         an on/off switch
 *   { group: 'Legend', fields: [...] }            short number fields side by side
 */
const CARDS = [
    {
        id: 'alerts',
        title: 'Notifications and alerts',
        top: 'channels', // the Pushover status and test button go first
        saved: 'Alert settings',
        intro: ['Sent once when a problem starts, as reminders while it lasts, and once when it is resolved. ', h('a', { href: '#/alerts' }, 'See current alerts'), '.'],
        fields: [
            { key: 'alerts.lag_threshold_minutes', label: 'Alert when a secondary is late by', unit: 'minutes', min: 1, hint: 'On top of each database’s log backup interval: with logs every 15 minutes and 10 here, it alerts after 25 minutes. Amber at half of it.' },
            { key: 'alerts.reminder_hours', label: 'Remind every', unit: 'hours', min: 0, step: 'any', hint: '0 = no reminders.' },
            { key: 'alerts.debounce_seconds', label: 'Wait before alerting', unit: 'seconds', min: 0, hint: 'A problem must last this long to alert, and be gone this long to resolve.' },
            { key: 'alerts.interval_seconds', label: 'Check alerts every', unit: 'seconds', min: 5 },
        ],
    },
    {
        id: 'monitoring',
        title: 'Monitoring',
        intro: 'How often Mostly-On looks at the servers.',
        fields: [
            { key: 'health.interval_seconds', label: 'Check server health every', unit: 'seconds', min: 5, hint: 'Connectivity, version and the state of every database.' },
            { key: 'restore.poll_seconds', label: 'Look for logs to restore every', unit: 'seconds', min: 5, hint: 'Secondaries also restore right after each backup; this is the fallback.' },
            { key: 'discovery.interval_seconds', label: 'Look for new databases every', unit: 'seconds', min: 30 },
        ],
    },
    {
        id: 'load',
        title: 'SQL Servers connections',
        intro:
            'Backups and restores over the limit wait their turn, in order, so a long FULL backup can hold up LOG backups and restores on the same server. ' +
            'Failovers and rollbacks never wait, and health checks have their own connections.',
        fields: [
            {
                key: 'servers.max_parallel',
                label: 'Backups and restores at a time, per server',
                min: 1,
                max: 10,
                hint: 'Server settings can override this value.',
            },
        ],
    },
    {
        id: 'retention',
        title: 'Backup retention',
        intro: 'The defaults; a database can have its own (on its page). Files a secondary still needs, and the newest complete set for each database, are always kept.',
        check: (v) => retentionProblem({ full: v['retention.full_days'], diff: v['retention.diff_days'], log: v['retention.log_days'] }),
        fields: [
            { key: 'retention.enabled', label: 'Delete old backup files', type: 'switch' },
            {
                group: 'Keep backups for (days)',
                fields: [
                    { key: 'retention.full_days', label: 'FULL', min: 1 },
                    { key: 'retention.diff_days', label: 'DIFF', min: 1 },
                    { key: 'retention.log_days', label: 'LOG', min: 1 },
                ],
            },
            { key: 'retention.interval_minutes', label: 'Look for old files every', unit: 'minutes', min: 1 },
        ],
    },
    {
        id: 'msdb',
        title: 'Backup history in SQL Server',
        intro: 'SQL Server records every backup and restore in msdb. With a log backup every few minutes, that history grows without limit and slows msdb down.',
        fields: [
            { key: 'msdb_history.purge_enabled', label: 'Purge old history on every server (daily)', type: 'switch' },
            { key: 'msdb_history.keep_days', label: 'Keep history for', unit: 'days', min: 1, hint: 'At least as long as your longest backup retention.' },
        ],
    },
];

const DEFAULT_SCHEDULES = [
    ['FULL', 'schedule.default_full'],
    ['DIFF', 'schedule.default_diff'],
    ['LOG', 'schedule.default_log'],
];

let seq = 0;
const uid = (key) => `set-${key.replace(/\W/g, '-')}-${++seq}`;

/** One field; returns [element, [{ f, input }]] so the card can read the values back. */
function settingField(f, values) {
    if (f.group) {
        const parts = f.fields.map((g) => settingField(g, values));
        return [h('fieldset.days', h('legend', f.group), parts.map(([el]) => el)), parts.flatMap(([, inputs]) => inputs)];
    }
    const id = uid(f.key);
    const hintId = f.hint ? `${id}-hint` : null;
    if (f.type === 'switch') {
        const input = h('input.switch', { type: 'checkbox', switch: true, role: 'switch', id, name: f.key, checked: !!values[f.key], 'aria-describedby': hintId });
        return [h('div.setting-switch', input, h('label', { for: id }, f.label), f.hint ? h('span.hint', { id: hintId }, f.hint) : null), [{ f, input }]];
    }
    const input = h('input', {
        type: 'number',
        id,
        name: f.key,
        value: String(values[f.key]),
        min: String(f.min ?? 0),
        max: f.max === undefined ? null : String(f.max),
        step: String(f.step ?? 1),
        required: true,
        inputmode: f.step === 'any' ? 'decimal' : 'numeric',
        'aria-describedby': [f.unit ? `${id}-unit` : null, hintId].filter(Boolean).join(' ') || null,
    });
    return [
        h(
            'div.field',
            h('label', { for: id }, f.label),
            h('div.with-unit', input, f.unit ? h('span.unit', { id: `${id}-unit` }, f.unit) : null),
            f.hint ? h('span.hint', { id: hintId }, f.hint) : null,
        ),
        [{ f, input }],
    ];
}

/** A card: heading, a line of explanation, its fields side by side, and its own Save. */
function settingsCard(card, values, extra = null) {
    const parts = card.fields.map((f) => settingField(f, values));
    const inputs = parts.flatMap(([, i]) => i);
    const problem = h('p.error-text', { role: 'alert' });
    const save = h('button.primary', { type: 'submit' }, 'Save', h('span.visually-hidden', ` ${card.title}`));
    const switches = parts.filter(([el]) => el.classList.contains('setting-switch')).map(([el]) => el);
    const rest = parts.filter(([el]) => !el.classList.contains('setting-switch')).map(([el]) => el);
    const form = h('form.card-form', { 'aria-labelledby': `h-${card.id}` }, switches, h('div.setting-grid', rest), problem, h('div.actions', save));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(inputs.map(({ f, input }) => [f.key, f.type === 'switch' ? input.checked : Number(input.value)]));
        problem.textContent = card.check?.(v) || '';
        if (problem.textContent) return;
        save.disabled = true; // no double posts
        try {
            await put('/api/settings', v);
            toast(`${card.saved ?? card.title} saved`, 'ok');
        } catch (err) {
            problem.textContent = err.message;
        } finally {
            save.disabled = false;
        }
    });
    return h('section.settings-card', { 'aria-labelledby': `h-${card.id}` }, h('h2', { id: `h-${card.id}` }, card.title), extra, card.intro ? h('p.muted.small', card.intro) : null, form);
}

export function settingsView() {
    let channelBox;
    let schedulesBox;

    async function loadChannels() {
        const d = await get('/api/notifications');
        const pushover = d.channels.find((c) => c.name === 'pushover');
        const testBtn = h('button', { type: 'button', onclick: () => sendTest(testBtn) }, 'Send test notification');
        clear(channelBox).append(
            ...[
                h(
                    'div.inline-row',
                    h('span', 'Pushover: ', pushover?.configured ? h('strong', 'configured') : h('strong', 'not configured')),
                    pushover?.configured ? testBtn : null,
                ),
                pushover?.configured ? null : h('p.small.muted', 'Set PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY in the controller’s environment and restart it.'),
                d.lastSentAt ? h('p.small.muted', `Last notification sent ${formatTime(d.lastSentAt)}.`) : null,
                d.lastError ? h('div.callout.err', h('strong', 'The last notification failed: '), d.lastError, d.nextAttemptAt ? ` Next attempt ${formatTime(d.nextAttemptAt)}.` : '') : null,
            ].filter((x) => x !== null),
        );
    }

    async function sendTest(btn) {
        btn.disabled = true;
        try {
            const r = await post('/api/notifications/test');
            toast(`Test notification sent (${r.sent.join(', ')})`, 'ok');
        } catch (err) {
            toast(err.message, 'err');
        } finally {
            btn.disabled = false;
            loadChannels().catch(() => {});
        }
    }

    function renderSchedules(values) {
        clear(schedulesBox).append(
            h(
                'dl.schedule-list',
                DEFAULT_SCHEDULES.map(([type, key]) => [
                    h('dt', type),
                    h('dd', describeSchedule(values[key])),
                    h(
                        'dd',
                        h(
                            'button.small-button',
                            {
                                type: 'button',
                                onclick: async () => {
                                    const updated = await scheduleDialog({
                                        title: `Default ${type} schedule`,
                                        schedule: values[key],
                                        withEnabled: type === 'DIFF', // FULL and LOG backups are never optional
                                        onSubmit: (v) => put('/api/settings', { [key]: v }),
                                    });
                                    if (updated) {
                                        toast(`Default ${type} schedule saved`, 'ok');
                                        renderSchedules(updated);
                                    }
                                },
                            },
                            h('span', 'Edit'),
                            h('span.visually-hidden', ` default ${type} schedule`),
                        ),
                    ),
                ]),
            ),
        );
    }

    return {
        async render(el) {
            const values = await get('/api/settings');
            channelBox = h('div.stack-tight');
            schedulesBox = h('div');
            const cards = Object.fromEntries(CARDS.map((c) => [c.id, settingsCard(c, values, c.top === 'channels' ? channelBox : null)]));
            el.append(
                h('h1', 'Settings'),
                h('p.muted', 'Each box saves on its own.'),
                h(
                    'div.settings-grid',
                    cards.alerts,
                    cards.monitoring,
                    cards.load,
                    cards.retention,
                    h(
                        'section.settings-card',
                        { 'aria-labelledby': 'h-schedules' },
                        h('h2', { id: 'h-schedules' }, 'Default schedules'),
                        h(
                            'p.muted.small',
                            'For databases you start managing. Existing databases keep their own (edit those on the database’s page). Times are the controller’s local time. ' +
                                'DIFF backups are optional: they make restoring and reinitializing a secondary faster, at the cost of more backup files.',
                        ),
                        schedulesBox,
                    ),
                    cards.msdb,
                ),
            );
            renderSchedules(values);
            await loadChannels();
        },
    };
}
