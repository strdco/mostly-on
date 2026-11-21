import { h, clear, dataTable, badge, formDialog, field, toast, ago } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { stateText, chainBadge } from './overview.js';

export function setupBadge(setup) {
    if (!setup) return badge('setup not checked yet');
    return setup.ready ? badge(`ready (helper procedures v${setup.version})`, 'ok') : badge(setup.version == null ? 'setup needed' : 'setup out of date', 'err');
}

export function healthBadge(s) {
    if (!s.enabled) return badge('disabled');
    if (!s.health) return badge('unknown');
    return s.health.ok ? badge('reachable', 'ok') : badge('unreachable', 'err');
}

const NAME_CHARS = /[^A-Za-z0-9_.-]/g;

function serverFields(s = {}, { backupRoot = '/backup' } = {}) {
    const isEdit = !!s.id;
    // The name ends up in backup file names, so only the characters that are safe there are accepted;
    // spaces become dashes as you type.
    const name = h('input', { type: 'text', name: 'name', required: true, maxlength: 64, pattern: '[A-Za-z0-9_.\\-]{1,64}', value: s.name || '', spellcheck: 'false', autocapitalize: 'none' });
    name.addEventListener('input', () => {
        const clean = name.value.replace(/\s/g, '-').replace(NAME_CHARS, '');
        if (clean !== name.value) name.value = clean;
    });
    return [
        h(
            'div.field-row.name-host-port',
            field('Display name', name),
            field('Host', h('input', { type: 'text', name: 'host', required: true, value: s.host || '', spellcheck: 'false', autocapitalize: 'none' })),
            field('Port', h('input', { type: 'number', name: 'port', min: 1, max: 65535, value: s.port || 1433, inputmode: 'numeric' })),
        ),
        h(
            'div.field-row',
            field(
                'SQL login',
                h('input', { type: 'text', name: 'username', required: true, value: s.username || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' }),
                'Should be a low-privileged login.',
            ),
            field(
                'Password',
                h('input', { type: 'password', name: 'password', required: !isEdit, autocomplete: 'new-password' }),
                isEdit ? 'Leave empty to keep current password.' : null,
            ),
        ),
        field(
            'Shared backup folder, as this SQL Server sees it',
            h('input', { type: 'text', name: 'sql_backup_root', required: true, value: s.sql_backup_root || '/var/opt/mssql/backup', spellcheck: 'false', autocapitalize: 'none' }),
            'The folder all servers back up to, as a path on this server.',
        ),
        h(
            'details.more',
            h('summary', 'More options'),
            h(
                'div.stack',
                field(
                    'Shared backup folder, as Mostly On sees it (optional)',
                    h('input', { type: 'text', name: 'controller_backup_root', value: s.controller_backup_root || '', placeholder: backupRoot, spellcheck: 'false', autocapitalize: 'none' }),
                    `Leave empty to use ${backupRoot}. Only needed if this server’s share is mounted somewhere else in the Mostly On container.`,
                ),
                field(
                    'Folder for undo files of read-only copies (optional)',
                    h('input', { type: 'text', name: 'standby_root', value: s.standby_root || '', placeholder: s.default_data_path || '(the server’s data folder)', spellcheck: 'false', autocapitalize: 'none' }),
                    'A path on this SQL Server. Only used by readable (STANDBY) secondaries.',
                ),
                field('Encrypt connection', h('input', { type: 'checkbox', name: 'encrypt', checked: isEdit ? s.encrypt : true })),
                field(
                    'Trust server certificate',
                    h('input', { type: 'checkbox', name: 'trust_server_cert', checked: isEdit ? s.trust_server_cert : true }),
                    'Needed for SQL Server’s default self-signed certificate.',
                ),
            ),
        ),
        isEdit
            ? field('Enabled', h('input', { type: 'checkbox', name: 'enabled', checked: !!s.enabled }), 'Untick to pause all work on this server, for maintenance, without removing it.')
            : null,
    ];
}

function toPayload(v, isEdit) {
    const out = { ...v, port: Number(v.port) };
    if (!isEdit) out.enabled = true;
    return out;
}

export async function editServerDialog(s) {
    const info = await get('/api/info').catch(() => ({}));
    return formDialog({
        title: s ? `Edit server ${s.name}` : 'Register server',
        fields: serverFields(s || {}, info),
        submitLabel: s ? 'Save' : 'Register',
        onSubmit: (v) => (s ? put(`/api/servers/${s.id}`, toPayload(v, true)) : post('/api/servers', toPayload(v, false))),
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
                                    location.hash = `#/servers/${s.id}`;
                                    await afterRegister(s);
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

function downloadSetupScript(id) {
    const a = h('a', { href: `/api/servers/${id}/setup-script`, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
}

/**
 * Right after "Register": the server is not usable until its setup script has
 * run, so say so and offer the script. Skipped when it is already set up.
 */
async function afterRegister(s) {
    const hh = s.health;
    if (hh?.ok && hh.setup?.ready) {
        toast(`Server ${s.name} is registered and ready`, 'ok');
        return;
    }
    const steps = [];
    if (hh && !hh.ok) {
        steps.push(
            h('li', 'Make sure Mostly On can connect. It could not: ', h('span.mono', String(hh.error).replace(/\.$/, '')), '. If the login does not exist yet, create it on ', h('strong', s.name), ' first.'),
        );
    }
    steps.push(
        h('li', 'Download the setup script. It already has this server’s backup folder and the login ', h('strong', s.username), ' filled in.'),
        h('li', 'Run it on ', h('strong', s.name), ' as a sysadmin, in SSMS, Azure Data Studio or sqlcmd. Running it again later is always safe.'),
        h('li', 'Come back to this page. Within a minute it shows ', h('strong', 'ready'), ' (or press Check now).'),
    );
    await formDialog({
        title: `One more step for ${s.name}`,
        fields: [
            h('p', `${s.name} is registered, but Mostly On cannot back up or restore there until its setup script has been run. `
                + 'The script installs a few signed procedures in master, so Mostly On can do its job without a sysadmin login.'),
            h('ol.steps-list', steps),
        ],
        submitLabel: 'Download setup script',
        cancelLabel: 'Later',
        onSubmit: () => downloadSetupScript(s.id),
    });
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
        const [s, roles, info] = await Promise.all([get(`/api/servers/${id}`), get(`/api/servers/${id}/roles`), get('/api/info').catch(() => ({}))]);
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
                    h('dt', 'Backup path (SQL Server)'), h('dd.mono', s.sql_backup_root),
                    h('dt', 'Backup path (Mostly On)'), h('dd.mono', s.controller_backup_root || `${info.backupRoot ?? 'BACKUP_ROOT'} (default)`),
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
            h('p', h(hh?.setup?.ready ? 'a.button' : 'a.button.primary', { href: `/api/servers/${id}/setup-script`, download: '' }, 'Download setup script')),
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
