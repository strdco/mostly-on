// Settings: notifications, alert rules, monitoring intervals, retention, msdb
// history and the default schedules for newly managed databases. Every
// section saves on its own; the server validates everything before storing.
import { h, clear, field, toast, formatTime, dataTable } from '../dom.js';
import { get, post, put } from '../api.js';
import { scheduleDialog, describeSchedule } from './schedule.js';

const SECTIONS = [
    {
        id: 'alerts',
        title: 'Alerts',
        intro: [
            'Alerts are sent once when a problem starts, as reminders while it lasts, and once when it is resolved. ',
            h('a', { href: '#/alerts' }, 'See current alerts'),
            '.',
        ],
        fields: [
            { key: 'alerts.lag_threshold_minutes', label: 'Lag threshold (minutes)', min: 1, hint: 'Alert when a secondary’s newest restored log is older than this. Rows turn amber at half of it.' },
            { key: 'alerts.reminder_hours', label: 'Reminder interval (hours)', min: 0, step: 'any', hint: 'Repeat a notification while the problem lasts. 0 = no reminders.' },
            { key: 'alerts.debounce_seconds', label: 'Debounce (seconds)', min: 0, hint: 'A problem must last this long before it alerts, and be gone this long before it resolves.' },
            { key: 'alerts.interval_seconds', label: 'Check alerts every (seconds)', min: 5 },
        ],
    },
    {
        id: 'monitoring',
        title: 'Monitoring',
        fields: [
            { key: 'health.interval_seconds', label: 'Check server health every (seconds)', min: 5, hint: 'Connectivity, version and the state of every database.' },
            { key: 'restore.poll_seconds', label: 'Look for logs to restore every (seconds)', min: 5, hint: 'Secondaries also restore right after each backup; this poll is the fallback.' },
            { key: 'discovery.interval_seconds', label: 'Look for new databases every (seconds)', min: 30 },
        ],
    },
    {
        id: 'retention',
        title: 'Backup retention',
        intro: 'Backup files a secondary still needs, and the newest complete set needed to restore each database, are always kept, whatever their age.',
        fields: [
            { key: 'retention.enabled', label: 'Delete old backup files', type: 'checkbox' },
            { key: 'retention.full_days', label: 'Keep FULL backups (days)', min: 1 },
            { key: 'retention.diff_days', label: 'Keep DIFF backups (days)', min: 1 },
            { key: 'retention.log_days', label: 'Keep LOG backups (days)', min: 1 },
            { key: 'retention.interval_minutes', label: 'Run retention every (minutes)', min: 1 },
        ],
    },
    {
        id: 'msdb',
        title: 'Backup history in SQL Server',
        intro: 'SQL Server records every backup and restore in its msdb database. With a log backup every few minutes, that history grows without limit and slows msdb down.',
        fields: [
            { key: 'msdb_history.purge_enabled', label: 'Purge old backup and restore history on every server (daily)', type: 'checkbox' },
            { key: 'msdb_history.keep_days', label: 'Keep history (days)', min: 1, hint: 'Keep at least as long as your longest backup retention.' },
        ],
    },
];

const DEFAULT_SCHEDULES = [
    ['FULL', 'schedule.default_full'],
    ['DIFF', 'schedule.default_diff'],
    ['LOG', 'schedule.default_log'],
];

function sectionForm(section, values) {
    const inputs = section.fields.map((f) => {
        const input =
            f.type === 'checkbox'
                ? h('input', { type: 'checkbox', name: f.key, checked: !!values[f.key] })
                : h('input', { type: 'number', name: f.key, value: String(values[f.key]), min: String(f.min ?? 0), step: String(f.step ?? 1), required: true, inputmode: f.step === 'any' ? 'decimal' : 'numeric' });
        return [f, input];
    });
    const save = h('button.primary', { type: 'submit' }, `Save ${section.title.toLowerCase()}`);
    const form = h(
        'form.stack.settings-form',
        { 'aria-labelledby': `h-${section.id}` },
        inputs.map(([f, input]) => field(f.label, input, f.hint)),
        h('div.actions', save),
    );
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        save.disabled = true; // no double posts
        try {
            await put('/api/settings', Object.fromEntries(inputs.map(([f, input]) => [f.key, f.type === 'checkbox' ? input.checked : Number(input.value)])));
            toast(`${section.title} saved`, 'ok');
        } catch (err) {
            toast(err.message, 'err');
        } finally {
            save.disabled = false;
        }
    });
    return [h('h2', { id: `h-${section.id}` }, section.title), section.intro ? h('p.muted', section.intro) : null, form];
}

export function settingsView() {
    let channelBox;
    let schedulesBox;

    async function loadChannels() {
        const d = await get('/api/notifications');
        const pushover = d.channels.find((c) => c.name === 'pushover');
        clear(channelBox).append(
            ...[
                h(
                    'p',
                    'Pushover: ',
                    pushover?.configured
                        ? h('strong', 'configured')
                        : [h('strong', 'not configured'), '. Set PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY in the controller’s environment and restart it.'],
                ),
                d.lastSentAt ? h('p.muted', `Last notification sent ${formatTime(d.lastSentAt)}.`) : null,
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
            dataTable({
                caption: 'Default schedules',
                rows: DEFAULT_SCHEDULES,
                columns: [
                    { label: 'Type', header: true, cell: ([type]) => type },
                    { label: 'Schedule', cell: ([, key]) => describeSchedule(values[key]) },
                    {
                        label: 'Actions',
                        cell: ([type, key]) =>
                            h(
                                'button',
                                {
                                    type: 'button',
                                    onclick: async () => {
                                        const updated = await scheduleDialog({
                                            title: `Default ${type} schedule`,
                                            schedule: values[key],
                                            withEnabled: false,
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
                    },
                ],
            }),
        );
    }

    return {
        async render(el) {
            const values = await get('/api/settings');
            channelBox = h('div');
            schedulesBox = h('div');
            const testBtn = h('button', { type: 'button', onclick: () => sendTest(testBtn) }, 'Send test notification');
            el.append(
                h('h1', 'Settings'),
                h('h2', 'Notifications'),
                channelBox,
                h('div.actions', testBtn),
                ...SECTIONS.flatMap((s) => sectionForm(s, values)).filter((x) => x !== null),
                h('h2', 'Default schedules'),
                h('p.muted', 'Used when you start managing a database. Existing databases keep their own schedules (edit those on the database’s page). Times are the controller’s local time.'),
                schedulesBox,
            );
            renderSchedules(values);
            await loadChannels();
        },
    };
}
