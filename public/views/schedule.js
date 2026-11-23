// Backup schedule editor, shared by the database page and the default
// schedules in Settings.
import { h, formDialog, field } from '../dom.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isOn = (s) => s.enabled !== 0 && s.enabled !== false; // a default schedule stored without `enabled` is on

export function describeSchedule(s) {
    if (!isOn(s)) return 'disabled';
    if (s.kind === 'interval') return `every ${s.interval_minutes} min`;
    if (s.kind === 'daily') return `daily at ${s.at_time}`;
    return `${WEEKDAYS[s.weekday]}s at ${s.at_time}`;
}

/**
 * Opens the editor. `onSubmit` gets { enabled?, kind, interval_minutes, at_time, weekday }
 * with only the fields that apply to the chosen kind.
 */
export function scheduleDialog({ title, schedule: s, withEnabled = true, onSubmit }) {
    const kind = h(
        'select',
        { name: 'kind' },
        [
            ['interval', 'Every N minutes'],
            ['daily', 'Daily'],
            ['weekly', 'Weekly'],
        ].map(([k, label]) => h('option', { value: k, selected: s.kind === k }, label)),
    );
    const interval = field('Every (minutes)', h('input', { type: 'number', name: 'interval_minutes', min: 1, max: 10080, step: 1, value: s.interval_minutes || 5, inputmode: 'numeric' }));
    const time = field('At (controller local time)', h('input', { type: 'time', name: 'at_time', value: s.at_time || '01:00' }));
    const weekday = field('Day', h('select', { name: 'weekday' }, WEEKDAYS.map((d, i) => h('option', { value: i, selected: s.weekday === i }, d))));
    const sync = () => {
        interval.hidden = kind.value !== 'interval';
        time.hidden = kind.value === 'interval';
        weekday.hidden = kind.value !== 'weekly';
    };
    kind.addEventListener('change', sync);
    sync();
    return formDialog({
        title,
        fields: [
            withEnabled ? field('Enabled', h('input.switch', { type: 'checkbox', switch: true, role: 'switch', name: 'enabled', checked: isOn(s) })) : null,
            field('Repeat', kind),
            interval,
            time,
            weekday,
        ],
        onSubmit: (v) => {
            const out = { kind: v.kind };
            if (withEnabled) out.enabled = v.enabled;
            if (v.kind === 'interval') out.interval_minutes = Number(v.interval_minutes);
            else out.at_time = v.at_time;
            if (v.kind === 'weekly') out.weekday = Number(v.weekday);
            return onSubmit(out);
        },
    });
}
