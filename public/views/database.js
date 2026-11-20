import { h, clear, dataTable, badge, formDialog, field, toast, formatBytes, formatTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { stateBadge, ageBadge, expectedMinutes } from './overview.js';
import { operationsTable } from './operations.js';
import { eventsTable } from './events.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeSchedule(s) {
    if (!s.enabled) return 'disabled';
    if (s.kind === 'interval') return `every ${s.interval_minutes} min`;
    if (s.kind === 'daily') return `daily at ${s.at_time}`;
    return `${WEEKDAYS[s.weekday]}s at ${s.at_time}`;
}

async function editSchedule(db, s) {
    const kind = h(
        'select',
        { name: 'kind' },
        ['interval', 'daily', 'weekly'].map((k) => h('option', { value: k, selected: s.kind === k }, k)),
    );
    const interval = field('Every (minutes)', h('input', { type: 'number', name: 'interval_minutes', min: 1, max: 10080, value: s.interval_minutes || 5 }));
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
        title: `${s.backup_type} schedule for ${db.name}`,
        fields: [field('Enabled', h('input', { type: 'checkbox', name: 'enabled', checked: s.enabled })), field('Kind', kind), interval, time, weekday],
        onSubmit: (v) =>
            put(`/api/databases/${db.id}/schedules/${s.backup_type}`, {
                enabled: v.enabled,
                kind: v.kind,
                interval_minutes: Number(v.interval_minutes),
                at_time: v.at_time,
                weekday: Number(v.weekday),
            }),
    });
}

export function databaseView(id) {
    let root;
    let timer;

    async function backupNow(type) {
        try {
            const r = await post(`/api/databases/${id}/backups`, { type });
            toast(`${r.type} backup started (operation #${r.operation.id})${r.type !== type ? ` instead of ${type}` : ''}`, 'ok');
        } catch (err) {
            toast(err.message, 'err');
        }
    }

    async function unmanage(db) {
        const ok = await formDialog({
            title: `Stop managing ${db.name}?`,
            fields: [
                h('p', 'Schedules stop and no more backups or restores run. Nothing is changed on the servers and backup files stay on disk.'),
                field(`Type ${db.name} to confirm`, h('input', { type: 'text', name: 'confirm', required: true, autocomplete: 'off', spellcheck: 'false' })),
            ],
            submitLabel: 'Stop managing',
            danger: true,
            onSubmit: (v) => post(`/api/databases/${id}/unmanage`, { confirm: v.confirm }),
        });
        if (ok) location.hash = '#/';
    }

    async function load() {
        const [db, files, evts] = await Promise.all([
            get(`/api/databases/${id}`),
            get(`/api/databases/${id}/backups?limit=100`),
            get(`/api/events?database_id=${id}&limit=50`),
        ]);
        const unacked = db.foreignBackups.filter((f) => !f.acknowledged_at);
        clear(root).append(
            h('h1', db.name),
            h(
                'div.actions',
                ['FULL', 'DIFF', 'LOG'].map((t) => h('button', { type: 'button', onclick: () => backupNow(t) }, `Back up ${t} now`)),
                h('button.danger', { type: 'button', onclick: () => unmanage(db) }, 'Stop managing'),
            ),
            unacked.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Backups not taken by Mostly On were found. '),
                      'A foreign LOG backup breaks the chain for every secondary; a foreign FULL changes the differential base.',
                      h(
                          'ul',
                          unacked.map((f) =>
                              h(
                                  'li',
                                  `${f.type} on ${f.server_name} at ${formatTime(f.finish_at)} to `,
                                  h('span.mono', f.device),
                                  ' ',
                                  h(
                                      'button.link',
                                      {
                                          type: 'button',
                                          onclick: async () => {
                                              await post(`/api/foreign-backups/${f.backup_set_uuid}/acknowledge`);
                                              load();
                                          },
                                      },
                                      'Acknowledge',
                                  ),
                              ),
                          ),
                      ),
                  )
                : null,
            db.busy.length ? h('p', badge(`Running: ${db.busy.join(', ')}`)) : null,
            h('h2', 'Replicas'),
            dataTable({
                caption: 'Replicas',
                rows: db.replicas,
                columns: [
                    { label: 'Server', header: true, cell: (r) => h('a', { href: `#/servers/${r.server_id}` }, r.server_name) },
                    { label: 'Role', cell: (r) => r.role },
                    { label: 'State', cell: (r) => stateBadge(r.live, r.role) },
                    { label: 'Reachable', cell: (r) => (r.reachable ? badge('yes', 'ok') : badge('no', 'err')) },
                ],
            }),
            h('h2', 'Schedules'),
            dataTable({
                caption: 'Backup schedules',
                rows: db.schedules,
                columns: [
                    { label: 'Type', header: true, cell: (s) => s.backup_type },
                    { label: 'Schedule', cell: (s) => describeSchedule(s) },
                    { label: 'Last backup', cell: (s) => ageBadge(db.latest[s.backup_type]?.backup_finish, expectedMinutes(s)) },
                    { label: 'Last run', cell: (s) => (s.last_status ? [formatTime(s.last_run_at), ' ', badge(s.last_status, s.last_status.startsWith('ok') ? 'ok' : 'err')] : '–') },
                    { label: 'Next run', cell: (s) => formatTime(s.next_run_at) },
                    {
                        label: 'Actions',
                        cell: (s) =>
                            h(
                                'button',
                                {
                                    type: 'button',
                                    onclick: async () => {
                                        if (await editSchedule(db, s)) load();
                                    },
                                },
                                'Edit',
                            ),
                    },
                ],
            }),
            h('h2', 'Backup history'),
            dataTable({
                caption: '100 most recent backup files',
                rows: files,
                empty: 'No backups yet.',
                columns: [
                    { label: 'Type', header: true, cell: (f) => f.type + (f.is_tail ? ' (tail)' : '') },
                    { label: 'Finished', cell: (f) => formatTime(f.backup_finish) },
                    { label: 'File', cell: (f) => h('span.mono', f.rel_path.split('/').pop()) },
                    { label: 'Size', num: true, cell: (f) => formatBytes(f.size_bytes) },
                    { label: 'LSN range', cell: (f) => h('span.mono', `${f.first_lsn} – ${f.last_lsn}`) },
                    { label: 'On disk', cell: (f) => badge(f.file_status, f.file_status === 'present' ? 'ok' : f.file_status === 'missing' ? 'err' : '') },
                ],
            }),
            h('h2', 'Operations'),
            operationsTable(db.operations, 'Recent operations (excluding routine scheduled backups)'),
            h('h2', 'Events'),
            eventsTable(evts, 'Recent events'),
        );
    }

    return {
        async render(el) {
            root = h('div');
            el.append(root);
            await load();
        },
        onEvent(evt) {
            const p = evt.payload || {};
            const relevant =
                (['database.changed', 'backup.finished', 'backup.failed', 'foreign.detected'].includes(evt.type) && p.databaseId === id) ||
                (evt.type === 'operation.updated' && p.databaseId === id && p.status !== 'running') ||
                (evt.type === 'event' && p.databaseId === id) ||
                evt.type === 'server.health';
            if (!relevant) return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 400);
        },
    };
}
