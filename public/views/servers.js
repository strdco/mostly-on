import { h, clear, dataTable, badge, formDialog, field, toast, ago } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { stateText, chainBadge } from './overview.js';

export function setupBadge(setup) {
    if (!setup) return badge('setup: unknown');
    return setup.ready ? badge(`ready (helper procedures v${setup.version})`, 'ok') : badge(setup.version == null ? 'setup needed' : 'setup out of date', 'err');
}

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
            field(
                'SQL login',
                h('input', { type: 'text', name: 'username', required: true, value: s.username || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' }),
                'Needs sysadmin: Mostly On backs up, restores and fails over databases.',
            ),
            field(
                'Password',
                h('input', { type: 'password', name: 'password', required: !isEdit, autocomplete: 'new-password' }),
                isEdit ? 'Leave empty to keep the stored password.' : null,
            ),
        ),
        h(
            'p.muted',
            'All servers write their backups to one shared folder, and Mostly On reads them from there. The folder can have a different path on each machine, so tell Mostly On where it is in both places.',
        ),
        field(
            'Shared backup folder, as this SQL Server sees it',
            h('input', { type: 'text', name: 'sql_backup_root', required: true, value: s.sql_backup_root || '/var/opt/mssql/backup', spellcheck: 'false' }),
            'The path you would use in BACKUP DATABASE ... TO DISK on this server.',
        ),
        field(
            'Shared backup folder, as Mostly On sees it',
            h('input', { type: 'text', name: 'controller_backup_root', value: s.controller_backup_root || '', placeholder: '(leave empty to use BACKUP_ROOT)', spellcheck: 'false' }),
            'Only needed if this server’s share is mounted somewhere other than BACKUP_ROOT in the Mostly On container.',
        ),
        field(
            'Folder for undo files of read-only copies (optional)',
            h('input', { type: 'text', name: 'standby_root', value: s.standby_root || '', placeholder: '(leave empty to use the server’s data folder)', spellcheck: 'false' }),
            'Only used when a secondary on this server is readable (STANDBY). A path on this SQL Server.',
        ),
        h(
            'div.field-row',
            field('Encrypt connection', h('input', { type: 'checkbox', name: 'encrypt', checked: s.id ? s.encrypt : true })),
            field(
                'Trust server certificate',
                h('input', { type: 'checkbox', name: 'trust_server_cert', checked: s.id ? s.trust_server_cert : true }),
                'Needed for SQL Server’s default self-signed certificate. Untick if the server has a certificate your systems trust.',
            ),
            field(
                'Enabled',
                h('input', { type: 'checkbox', name: 'enabled', checked: s.id ? s.enabled : true }),
                'Untick to pause all work on this server (for maintenance) without removing it.',
            ),
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
                    { label: 'Status', cell: (s) => [healthBadge(s), s.health?.setup && !s.health.setup.ready ? [' ', setupBadge(s.health.setup)] : null] },
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

/** "Switch over all databases on this server to another one", shown with the per-database plan. */
async function switchoverDialog(s) {
    const others = (await get('/api/servers')).filter((x) => x.id !== s.id && x.enabled);
    if (!others.length) throw new Error('There is no other enabled server to fail over to');
    const target = h('select', { name: 'to_server_id' }, others.map((o) => h('option', { value: o.id }, o.name)));
    const planId = `plan-${Math.random().toString(36).slice(2, 9)}`;
    const plan = h('div', { id: planId, role: 'status', 'aria-live': 'polite' });
    target.setAttribute('aria-describedby', planId);
    const load = async () => {
        plan.replaceChildren(h('p.muted', 'Checking…'));
        try {
            const p = await get(`/api/servers/${s.id}/switchover-plan?to=${target.value}`);
            plan.replaceChildren(
                h('p', `Each database moves in turn, with a tail-log backup so nothing is lost; ${s.name} becomes its secondary. If one fails, the rest are not started.`),
                h('ul', p.databases.map((d) => h('li', d.name, d.problem ? [' ', badge(d.problem, 'err')] : [' ', badge('ready', 'ok')]))),
            );
        } catch (err) {
            plan.replaceChildren(h('p.error-text', err.message));
        }
    };
    target.addEventListener('change', load);
    load();
    return formDialog({
        title: `Fail over every database whose primary is ${s.name}`,
        fields: [
            field('Move the primaries to', target),
            plan,
            field(`Type ${s.name} to confirm`, h('input', { type: 'text', name: 'confirm', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })),
        ],
        submitLabel: 'Fail over all',
        danger: true,
        onSubmit: (v) => post(`/api/servers/${s.id}/switchover`, { to_server_id: Number(v.to_server_id), confirm: v.confirm }),
    });
}

export function serverDetailView(id) {
    let root;
    let timer;
    async function load() {
        const [s, roles] = await Promise.all([get(`/api/servers/${id}`), get(`/api/servers/${id}/roles`)]);
        const hh = s.health;
        const primaries = roles.filter((r) => r.role === 'primary');
        // Native append() would render null as the text "null"; filter it out.
        clear(root).append(...[
            h('h1', `Server ${s.name}`),
            h(
                'div.actions',
                h('button', { type: 'button', onclick: async () => { await post(`/api/servers/${id}/check`); load(); } }, 'Check now'),
                primaries.length
                    ? h(
                          'button.primary',
                          {
                              type: 'button',
                              onclick: async () => {
                                  try {
                                      const r = await switchoverDialog(s);
                                      if (r?.operation) toast(`Switch-over started (operation #${r.operation.id})`, 'ok');
                                  } catch (err) {
                                      toast(err.message, 'err');
                                  }
                              },
                          },
                          `Fail over all ${primaries.length} database${primaries.length === 1 ? '' : 's'}…`,
                      )
                    : null,
                h('button', { type: 'button', onclick: async () => { if (await editServerDialog(s)) load(); } }, 'Edit'),
                h(
                    'button.danger',
                    {
                        type: 'button',
                        onclick: async () => {
                            const ok = await formDialog({
                                title: `Remove server ${s.name}?`,
                                fields: [h('p', 'The server is removed from Mostly On. Nothing on the SQL Server is changed.')],
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
            h('h2', 'Setup'),
            h(
                'p.muted',
                `Mostly On does not need a sysadmin login. Its backups, restores and failovers run through signed helper procedures in master, which a sysadmin installs once with this server's setup script. `
                    + 'Run the script again whenever this page says it is out of date; running it again is always safe.',
            ),
            h(
                'p',
                setupBadge(hh?.setup),
                ' ',
                hh?.setup?.login ? h('span.muted', `Mostly On connects as ${hh.setup.login}.`) : null,
            ),
            h('p', h('a.button', { href: `/api/servers/${id}/setup-script`, download: '' }, 'Download setup script')),
            h('h2', 'Managed databases on this server'),
            dataTable({
                caption: 'Roles of this server',
                rows: roles,
                empty: 'This server holds no managed replicas.',
                columns: [
                    { label: 'Database', header: true, cell: (r) => h('a', { href: `#/databases/${r.database_id}` }, r.database_name) },
                    { label: 'Role', cell: (r) => badge(r.role === 'diverged' ? 'old primary, out of sync' : r.role, r.role === 'diverged' ? 'err' : '') },
                    { label: 'Shipping', cell: (r) => (r.role === 'secondary' ? chainBadge(r) : '') },
                ],
            }),
            h('h2', 'Databases on this instance'),
            dataTable({
                caption: 'User databases (from sys.databases)',
                rows: hh?.databases || [],
                empty: hh?.ok ? 'No user databases.' : 'Not available while the server is unreachable.',
                columns: [
                    { label: 'Database', header: true, cell: (d) => d.name },
                    { label: 'State', cell: (d) => badge(stateText(d, d.state === 'RESTORING' ? 'secondary' : 'primary'), d.state === 'ONLINE' || d.state === 'RESTORING' ? 'ok' : 'warn') },
                    { label: 'Recovery model', cell: (d) => d.recoveryModel },
                    { label: 'Access', cell: (d) => d.userAccess },
                ],
            }),
        ].filter((x) => x !== null));
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
