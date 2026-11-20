import { h, clear, dataTable, badge, formDialog, toast, ago } from '../dom.js';
import { get, post } from '../api.js';

export function stateBadge(live, role) {
    if (!live) return badge('unknown');
    const expected = role === 'primary' ? live.state === 'ONLINE' : live.state === 'RESTORING' || live.isInStandby;
    return badge(live.isInStandby ? 'STANDBY' : live.state, expected ? 'ok' : 'err');
}

/** Age badge for a last-backup timestamp against an expected interval (minutes). */
export function ageBadge(iso, expectMinutes) {
    if (!iso) return badge('never', 'warn');
    const mins = (Date.now() - new Date(iso).getTime()) / 60000;
    const kind = !expectMinutes ? '' : mins > expectMinutes * 3 ? 'err' : mins > expectMinutes * 1.5 ? 'warn' : 'ok';
    return badge(ago(iso), kind);
}

export function expectedMinutes(schedule) {
    if (!schedule?.enabled) return null;
    if (schedule.kind === 'interval') return schedule.interval_minutes;
    if (schedule.kind === 'daily') return 24 * 60;
    return 7 * 24 * 60;
}

export function overviewView() {
    let managedBox;
    let discoveredBox;
    let timer;

    async function load() {
        const [dbs, discovered] = await Promise.all([get('/api/databases'), get('/api/discovered')]);
        clear(managedBox).append(
            dataTable({
                caption: 'Managed databases',
                rows: dbs,
                empty: 'No managed databases yet. Pick one from the list below.',
                columns: [
                    { label: 'Database', header: true, cell: (d) => h('a', { href: `#/databases/${d.id}` }, d.name) },
                    { label: 'Primary', cell: (d) => (d.primary ? [d.primary.server_name, ' ', stateBadge(d.primary.live, 'primary')] : badge('none', 'err')) },
                    {
                        label: 'Secondaries',
                        cell: (d) => {
                            const sec = d.replicas.filter((r) => r.role !== 'primary');
                            return sec.length ? sec.map((r) => h('div', r.server_name, ' ', stateBadge(r.live, r.role))) : h('span.muted', 'none');
                        },
                    },
                    ...['FULL', 'DIFF', 'LOG'].map((t) => ({
                        label: `Last ${t}`,
                        cell: (d) => ageBadge(d.latest[t]?.backup_finish, expectedMinutes(d.schedules.find((s) => s.backup_type === t))),
                    })),
                    {
                        label: 'Chain',
                        cell: (d) => (d.foreignLogBackups ? badge(`${d.foreignLogBackups} foreign log backup(s)`, 'err') : badge('ok', 'ok')),
                    },
                    { label: 'Activity', cell: (d) => (d.busy.length ? badge(d.busy.join(', ')) : '') },
                ],
            }),
        );
        clear(discoveredBox).append(
            dataTable({
                caption: 'Databases found on servers',
                rows: discovered,
                empty: 'No unmanaged user databases found.',
                columns: [
                    { label: 'Database', header: true, cell: (d) => d.name },
                    { label: 'Server', cell: (d) => d.server_name },
                    { label: 'Recovery model', cell: (d) => (d.shippable ? d.recovery_model : badge(`${d.recovery_model}: not shippable`, 'warn')) },
                    { label: 'State', cell: (d) => d.state },
                    {
                        label: 'Actions',
                        cell: (d) =>
                            h(
                                'div.actions',
                                d.shippable
                                    ? h('button.primary', { type: 'button', onclick: () => manage(d) }, 'Manage')
                                    : null,
                                h('button', { type: 'button', onclick: () => dismiss(d) }, 'Dismiss'),
                            ),
                    },
                ],
            }),
        );
    }

    async function manage(d) {
        const res = await formDialog({
            title: `Manage ${d.name}?`,
            fields: [
                h('p', `${d.server_name} becomes the primary for ${d.name}. Mostly On takes a FULL backup right away and then runs the default schedules (FULL weekly, DIFF daily, LOG every 5 minutes).`),
                h('p.muted', 'From now on, other tools must not take non-copy-only backups of this database, or the log chain breaks.'),
            ],
            submitLabel: 'Manage',
            onSubmit: () => post('/api/databases', { server_id: d.server_id, name: d.name }),
        });
        if (res) {
            toast(res.warning || `Managing ${d.name}; initial FULL backup started`, res.warning ? 'err' : 'ok');
            location.hash = `#/databases/${res.database.id}`;
        }
    }

    async function dismiss(d) {
        try {
            await post('/api/discovered/dismiss', { server_id: d.server_id, name: d.name });
            load();
        } catch (err) {
            toast(err.message, 'err');
        }
    }

    return {
        async render(el) {
            managedBox = h('div');
            discoveredBox = h('div');
            el.append(h('h1', 'Overview'), managedBox, h('h2', 'Available to manage'), discoveredBox);
            await load();
        },
        onEvent(evt) {
            if (!['database.changed', 'backup.finished', 'backup.failed', 'discovery.changed', 'server.health', 'foreign.detected'].includes(evt.type)) return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 400);
        },
    };
}
