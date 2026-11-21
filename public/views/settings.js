// Settings: notification delivery and alert rules. (The other settings get a UI in Phase 6.)
import { h, clear, field, toast, formatTime } from '../dom.js';
import { get, post, put } from '../api.js';

const ALERT_FIELDS = [
    { key: 'alerts.lag_threshold_minutes', label: 'Lag threshold (minutes)', min: 1, step: 1, hint: 'Alert when a secondary’s newest restored log is older than this.' },
    { key: 'alerts.reminder_hours', label: 'Reminder interval (hours)', min: 0, step: 'any', hint: 'Repeat a notification while the problem lasts. 0 = no reminders.' },
    { key: 'alerts.debounce_seconds', label: 'Debounce (seconds)', min: 0, step: 1, hint: 'A problem must last this long before it alerts, and be gone this long before it resolves.' },
    { key: 'alerts.interval_seconds', label: 'Check every (seconds)', min: 5, step: 1, hint: 'How often the alert conditions are evaluated.' },
];

export function settingsView() {
    let channelBox;

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

    function alertForm(values) {
        const inputs = ALERT_FIELDS.map((f) => [f, h('input', { type: 'number', name: f.key, value: String(values[f.key]), min: String(f.min), step: String(f.step), required: true, inputmode: 'decimal' })]);
        const save = h('button.primary', { type: 'submit' }, 'Save alert settings');
        const form = h(
            'form.stack.settings-form',
            inputs.map(([f, input]) => field(f.label, input, f.hint)),
            h('div.actions', save),
        );
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            save.disabled = true; // no double posts
            try {
                await put('/api/settings', Object.fromEntries(inputs.map(([f, input]) => [f.key, Number(input.value)])));
                toast('Alert settings saved', 'ok');
            } catch (err) {
                toast(err.message, 'err');
            } finally {
                save.disabled = false;
            }
        });
        return form;
    }

    return {
        async render(el) {
            const values = await get('/api/settings');
            channelBox = h('div');
            const testBtn = h('button', { type: 'button', onclick: () => sendTest(testBtn) }, 'Send test notification');
            el.append(
                h('h1', 'Settings'),
                h('h2', 'Notifications'),
                channelBox,
                h('div.actions', testBtn),
                h('h2', 'Alerts'),
                h('p.muted', 'Alerts are sent once when a problem starts, as reminders while it lasts, and once when it is resolved. ', h('a', { href: '#/alerts' }, 'See current alerts'), '.'),
                alertForm(values),
            );
            await loadChannels();
        },
    };
}
