import { h, clear, dataTable, badge, formDialog, field, toast, ago } from '../dom.js';
import { get, post, put, del } from '../api.js';

export function healthBadge(s) {
    if (!s.enabled) return badge('disabled');
    if (!s.health) return badge('unknown');
    return s.health.ok ? badge('reachable', 'ok') : badge('unreachable', 'err');
}

function serverFields(s = {}) {
    const isEdit = !!s.id;
    return [
        h(
            'div.field-row',
            field('Name', h('input', { type: 'text', name: 'name', required: true, pattern: '[A-Za-z0-9_.\\-]{1,64}', value: s.name || '', spellcheck: 'false' }), 'Letters, digits, _ . -. Used in backup file names.'),
            field('Host', h('input', { type: 'text', name: 'host', required: true, value: s.host || '', spellcheck: 'false', autocapitalize: 'none' })),
            field('Port', h('input', { type: 'number', name: 'port', min: 1, max: 65535, value: s.port || 1433 })),
        ),
        h(
            'div.field-row',
            field('SQL login', h('input', { type: 'text', name: 'username', required: true, value: s.username || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' })),
            field(
                'Password',
                h('input', { type: 'password', name: 'password', required: !isEdit, autocomplete: 'new-password' }),
                isEdit ? 'Leave empty to keep the stored password.' : null,
            ),
        ),
        field(
            'Backup path as SQL Server sees it',
            h('input', { type: 'text', name: 'sql_backup_root', required: true, value: s.sql_backup_root || '/var/opt/mssql/backup', spellcheck: 'false' }),
            'Mount point of the shared backup volume inside this SQL Server container.',
        ),
        field(
            'Backup path as the controller sees it',
            h('input', { type: 'text', name: 'controller_backup_root', value: s.controller_backup_root || '', placeholder: '(default: BACKUP_ROOT)', spellcheck: 'false' }),
        ),
        field(
            'Standby undo file directory',
            h('input', { type: 'text', name: 'standby_root', value: s.standby_root || '', placeholder: '(default: the instance data directory)', spellcheck: 'false' }),
            'Only used for secondaries in STANDBY mode. SQL Server path.',
        ),
        h(
            'div.field-row',
            field('Encrypt connection', h('input', { type: 'checkbox', name: 'encrypt', checked: s.id ? s.encrypt : true })),
            field('Trust server certificate', h('input', { type: 'checkbox', name: 'trust_server_cert', checked: s.id ? s.trust_server_cert : true })),
            field('Enabled', h('input', { type: 'checkbox', name: 'enabled', checked: s.id ? s.enabled : true })),
        ),
    ];
}

function toPayload(v) {
    return { ...v, port: Number(v.port) };
}

export async function editServerDialog(s) {
    return formDialog({
        title: s ? `Edit server ${s.name}` : 'Register server',
        fields: serverFields(s || {}),
        submitLabel: s ? 'Save' : 'Register',
        onSubmit: (v) => (s ? put(`/api/servers/${s.id}`, toPayload(v)) : post('/api/servers', toPayload(v))),
    });
}

export function serversView() {
    let list;
    let timer;
    async function load() {
        const servers = await get('/api/servers');
        clear(list).append(
            dataTable({
                caption: 'Registered SQL Server instances',
                rows: servers,
                empty: 'No servers registered yet.',
                columns: [
                    { label: 'Server', header: true, cell: (s) => h('a', { href: `#/servers/${s.id}` }, s.name) },
                    { label: 'Address', cell: (s) => h('span.mono', `${s.host}:${s.port}`) },
                    { label: 'Status', cell: (s) => healthBadge(s) },
                    { label: 'Version', cell: (s) => (s.product_version ? `${s.health?.info?.versionName || ''} ${s.product_version}`.trim() : '–') },
                    { label: 'Edition', cell: (s) => s.edition || '–' },
                    { label: 'Databases', num: true, cell: (s) => (s.health?.ok ? String(s.health.databases.length) : '–') },
                    { label: 'Checked', cell: (s) => ago(s.health?.checkedAt) },
                ],
            }),
        );
    }
    return {
        async render(el) {
            list = h('div');
            el.append(
                h('h1', 'Servers'),
                h(
                    'div.actions',
                    h(
                        'button.primary',
                        {
                            type: 'button',
                            onclick: async () => {
                                const s = await editServerDialog(null);
                                if (s) {
                                    toast(`Server ${s.name} registered`, 'ok');
                                    load();
                                }
                            },
                        },
                        'Register server',
                    ),
                ),
                list,
            );
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'server.health') return;
            clearTimeout(timer);
            timer = setTimeout(load, 300);
        },
    };
}

export function serverDetailView(id) {
    let root;
    let timer;
    async function load() {
        const s = await get(`/api/servers/${id}`);
        const hh = s.health;
        clear(root).append(
            h('h1', `Server ${s.name}`),
            h(
                'div.actions',
                h('button', { type: 'button', onclick: async () => { await post(`/api/servers/${id}/check`); load(); } }, 'Check now'),
                h('button', { type: 'button', onclick: async () => { if (await editServerDialog(s)) load(); } }, 'Edit'),
                h(
                    'button.danger',
                    {
                        type: 'button',
                        onclick: async () => {
                            const ok = await formDialog({
                                title: `Remove server ${s.name}?`,
                                fields: [h('p', 'The server is removed from cheap-log. Nothing on the SQL Server is changed.')],
                                submitLabel: 'Remove',
                                danger: true,
                                onSubmit: () => del(`/api/servers/${id}`),
                            });
                            if (ok) location.hash = '#/servers';
                        },
                    },
                    'Remove',
                ),
            ),
            hh && !hh.ok ? h('div.callout.err', `Unreachable: ${hh.error}`) : null,
            ...(hh?.warnings || []).map((w) => h('div.callout.warn', w)),
            h(
                'section.panel',
                h(
                    'dl.kv',
                    h('dt', 'Status'), h('dd', healthBadge(s)),
                    h('dt', 'Address'), h('dd.mono', `${s.host}:${s.port}`),
                    h('dt', 'Version'), h('dd', s.product_version ? `${hh?.info?.versionName || ''} (${s.product_version})` : '–'),
                    h('dt', 'Edition'), h('dd', s.edition || '–'),
                    h('dt', 'Backup path (SQL)'), h('dd.mono', s.sql_backup_root),
                    h('dt', 'Backup path (controller)'), h('dd.mono', s.controller_backup_root || '(BACKUP_ROOT)'),
                    h('dt', 'Default data path'), h('dd.mono', s.default_data_path || '–'),
                    h('dt', 'Default log path'), h('dd.mono', s.default_log_path || '–'),
                    h('dt', 'Last seen'), h('dd', ago(s.last_seen_at)),
                ),
            ),
            h('h2', 'Databases on this instance'),
            dataTable({
                caption: 'User databases (from sys.databases)',
                rows: hh?.databases || [],
                empty: hh?.ok ? 'No user databases.' : 'Not available while the server is unreachable.',
                columns: [
                    { label: 'Database', header: true, cell: (d) => d.name },
                    { label: 'State', cell: (d) => badge(d.isInStandby ? 'STANDBY' : d.state, d.state === 'ONLINE' || d.state === 'RESTORING' ? 'ok' : 'warn') },
                    { label: 'Recovery model', cell: (d) => d.recoveryModel },
                    { label: 'Access', cell: (d) => d.userAccess },
                ],
            }),
        );
    }
    return {
        async render(el) {
            root = h('div');
            el.append(root);
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'server.health' || evt.payload.serverId !== id) return;
            clearTimeout(timer);
            timer = setTimeout(load, 300);
        },
    };
}
