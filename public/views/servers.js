import { h, clear, dataTable, badge, tipBadge, formDialog, field, toast, ago, tooltip, formatTime } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { stateText, stateBadge, chainBadge } from './overview.js';

/** host:port, or host\INSTANCE for a named instance. */
export function serverAddress(s) {
    return s.instance_name ? `${s.host}\\${s.instance_name}` : `${s.host}:${s.port}`;
}

/**
 * Where a server runs, from its last health check (inspect.js hostOf()):
 * { short: 'Linux container' | 'Linux' | 'Windows' ..., long: 'Ubuntu 24.04, in a container' }, or null.
 */
export function platformOf(host) {
    if (!host?.platform) return null;
    const os = host.platform === 'Windows' ? host.distribution || 'Windows' : [host.distribution, host.release].filter(Boolean).join(' ') || host.platform;
    return {
        short: host.container ? `${host.platform} container` : host.platform,
        long: host.container ? `${os}, in a container (Docker, Kubernetes or similar)` : `${os}, not in a container`,
    };
}

/** platformOf() as a neutral tag with the details in its tooltip. */
function platformTag(host) {
    const p = platformOf(host);
    return p ? tipBadge(p.short, '', p.long) : '–';
}

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

function serverFields(s = {}, { backupRoot = '/backup', maxParallel = 2 } = {}) {
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
                isEdit ? 'Leave empty to keep the current password. Changing the host, port, instance, login or encryption settings needs it again.' : null,
            ),
        ),
        field(
            'Shared backup folder, as this SQL Server sees it',
            h('input', { type: 'text', name: 'sql_backup_root', required: true, value: s.sql_backup_root || '/var/opt/mssql/backup', spellcheck: 'false', autocapitalize: 'none' }),
            'The folder all servers back up to, as a path on this server: for example /var/opt/mssql/backup, D:\\Backup or \\\\fileserver\\backup.'
                + (isEdit ? ' If you change it, run this server’s setup script again.' : ''),
        ),
        h(
            'details.more',
            h('summary', 'More options'),
            h(
                'div.stack',
                field(
                    'Instance name (optional)',
                    h('input', { type: 'text', name: 'instance_name', value: s.instance_name || '', placeholder: 'e.g. SQLEXPRESS', maxlength: 16, spellcheck: 'false', autocapitalize: 'none' }),
                    'For a named instance. Mostly-On then finds its port through the SQL Server Browser service (UDP 1434), and the port above is ignored. Leave empty to connect to the port directly.',
                ),
                field(
                    'Shared backup folder, as Mostly-On sees it (optional)',
                    h('input', { type: 'text', name: 'controller_backup_root', value: s.controller_backup_root || '', placeholder: backupRoot, spellcheck: 'false', autocapitalize: 'none' }),
                    `Leave empty to use ${backupRoot}. Only needed if this server’s share is mounted somewhere else in the Mostly-On container.`,
                ),
                field(
                    'Folder for undo files of read-only copies (optional)',
                    h('input', { type: 'text', name: 'standby_root', value: s.standby_root || '', placeholder: s.default_data_path || '(the server’s data folder)', spellcheck: 'false', autocapitalize: 'none' }),
                    'A path on this SQL Server. Only used by readable (STANDBY) secondaries.' + (isEdit ? ' If you change it, run this server’s setup script again.' : ''),
                ),
                field(
                    'Backups and restores at a time (optional)',
                    h('input', { type: 'number', name: 'max_parallel', min: 1, max: 10, step: 1, inputmode: 'numeric', value: s.max_parallel ?? '', placeholder: `${maxParallel} (default)` }),
                    `Leave empty to use the default (${maxParallel}, Settings). More wait their turn, in order. Health checks do not count, and failovers and rollbacks never wait.`,
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
                    { label: 'Address', cell: (s) => h('span.mono', serverAddress(s)) },
                    { label: 'Status', cell: (s) => [healthBadge(s), s.health?.setup && !s.health.setup.ready ? [' ', setupBadge(s.health.setup)] : null] },
                    { label: 'Version', cell: (s) => (s.product_version ? `${s.health?.info?.versionName || ''} ${s.product_version}`.trim() : '–') },
                    { label: 'Edition', cell: (s) => s.edition || '–' },
                    { label: 'Platform', cell: (s) => platformTag(s.health?.info?.host) },
                    // User databases; master, model and msdb are on every server.
                    { label: 'Databases', num: true, cell: (s) => (s.health?.ok ? String(s.health.databases.filter((d) => !isSystem(d)).length) : '–') },
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
            h('li', 'Make sure Mostly-On can connect. It could not: ', h('span.mono', String(hh.error).replace(/\.$/, '')), '. If the login does not exist yet, create it on ', h('strong', s.name), ' first.'),
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
            h('p', `${s.name} is registered, but Mostly-On cannot back up or restore there until its setup script has been run. `
                + 'The script installs a few signed procedures in master, so Mostly-On can do its job without a sysadmin login.'),
            h('ol.steps-list', steps),
        ],
        submitLabel: 'Download setup script',
        cancelLabel: 'Later',
        onSubmit: () => downloadSetupScript(s.id),
    });
}

/** "Switch over all databases on this server to another one", shown with the per-database plan. */
/**
 * "Fail over databases…": greyed out (reason in a tooltip) when none of the
 * primaries on this server has a working secondary anywhere.
 */
function failoverButton(s, targets) {
    const blocker = !targets
        ? null
        : !targets.from.reachable
          ? `${s.name} is unreachable. A failover without data loss needs it: fail each database over from its own page instead.`
          : !targets.targets.length
            ? `None of the databases whose primary is ${s.name} has a working secondary on another server.`
            : null;
    const button = h('button.primary', { type: 'button', 'aria-disabled': blocker ? 'true' : null }, 'Fail over databases…');
    const tip = blocker ? tooltip(button, blocker) : null;
    button.addEventListener('click', async () => {
        if (tip) return tip.show();
        try {
            const r = await switchoverDialog(s, targets);
            if (r?.operation) toast(`Failover of the databases started (operation #${r.operation.id})`, 'ok');
        } catch (err) {
            toast(err.message, 'err');
        }
    });
    return [button, tip?.tip];
}

/** Pick a target server; every database with a working secondary there moves, the rest stay. */
async function switchoverDialog(s, targets) {
    const opts = targets?.targets ?? [];
    const preferred = opts.find((t) => t.reachable) ?? opts[0];
    const target = h(
        'select',
        { name: 'to_server_id' },
        opts.map((t) =>
            h(
                'option',
                { value: t.id, selected: t === preferred, disabled: !t.reachable },
                `${t.name}: ${t.covers} of ${targets.total} database${targets.total === 1 ? '' : 's'}${t.reachable ? '' : ' (unreachable)'}`,
            ),
        ),
    );
    const planId = `plan-${Math.random().toString(36).slice(2, 9)}`;
    const plan = h('div', { id: planId, role: 'status', 'aria-live': 'polite' });
    target.setAttribute('aria-describedby', planId);
    const load = async () => {
        plan.replaceChildren(h('p.muted', 'Checking…'));
        try {
            const p = await get(`/api/servers/${s.id}/switchover-plan?to=${target.value}`);
            const moving = p.databases.filter((d) => d.moves);
            const staying = p.databases.filter((d) => !d.moves);
            // Native replaceChildren() would render null as the text "null"; filter it out.
            plan.replaceChildren(...[
                h('p', `${moving.length} database${moving.length === 1 ? '' : 's'} move${moving.length === 1 ? 's' : ''} to ${p.to.name}, one at a time, each with a tail-log backup so nothing is lost; ${s.name} becomes its secondary. If one fails, the rest wait until you resume.`),
                h('ul', moving.map((d) => h('li', d.name, ' ', badge(`moves to ${p.to.name}`, 'ok'), d.note ? h('div.small.warn-text', d.note) : null))),
                staying.length
                    ? h(
                          'div.callout.warn',
                          h('strong', `${staying.length} database${staying.length === 1 ? ' stays' : 's stay'} on ${s.name}`),
                          ` and ${staying.length === 1 ? 'is' : 'are'} unavailable while ${s.name} is down. To move ${staying.length === 1 ? 'it' : 'them'} too, run this again with another server, or fail over from the database's own page.`,
                          h('ul', staying.map((d) => h('li', `${d.name}: ${d.problem}`))),
                      )
                    : null,
            ].filter((x) => x !== null));
        } catch (err) {
            plan.replaceChildren(h('p.error-text', err.message));
        }
    };
    target.addEventListener('change', load);
    load();
    return formDialog({
        title: `Fail over databases from ${s.name}`,
        fields: [
            field('Move them to', target, 'Only servers that hold a working secondary of at least one of these databases are listed.'),
            plan,
            field(`Type ${s.name} to confirm`, h('input', { type: 'text', name: 'confirm', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })),
        ],
        submitLabel: 'Fail over',
        danger: true,
        onSubmit: (v) => post(`/api/servers/${s.id}/switchover`, { to_server_id: Number(v.to_server_id), confirm: v.confirm }),
    });
}

/** "Remove": greyed out (focusable, reason in a tooltip) while the server is still in use. */
function removeButton(s) {
    const button = h('button.danger', { type: 'button', 'aria-disabled': s.remove_blocker ? 'true' : null }, 'Remove');
    const tip = s.remove_blocker ? tooltip(button, `${s.name} cannot be removed yet. ${s.remove_blocker}`) : null;
    button.addEventListener('click', async () => {
        if (tip) return tip.show();
        const ok = await formDialog({
            title: `Remove server ${s.name}?`,
            fields: [
                h('p', `Mostly-On stops connecting to ${s.name} and no longer lists it. Nothing on the SQL Server is changed.`),
                h('p.muted', `Backups ${s.name} took stay usable until retention removes them. To use it again later, register a server under the same name.`),
            ],
            submitLabel: 'Remove',
            danger: true,
            onSubmit: () => del(`/api/servers/${s.id}`),
        });
        if (ok) location.hash = '#/servers';
    });
    return [button, tip?.tip];
}

/** master, model or msdb (by the id the server reports). */
const isSystem = (d) => d?.databaseId != null && [1, 3, 4].includes(d.databaseId);

/**
 * Every user database on the server, managed or not, by name. Managed ones
 * (roles) link to their page and show their role; the rest say "unmanaged".
 * State, recovery model and access come from the server's last health check.
 */
function serverDatabasesTable(roles, hh) {
    const key = (name) => name.toLowerCase(); // SQL Server names ignore case by default
    const live = new Map((hh?.ok ? hh.databases : []).map((d) => [key(d.name), d]));
    const rows = roles.map((r) => ({ name: r.database_name, role: r, live: live.get(key(r.database_name)) ?? null }));
    const managed = new Set(rows.map((x) => key(x.name)));
    for (const d of live.values()) if (!managed.has(key(d.name))) rows.push({ name: d.name, role: null, live: d });
    // System databases (master, model, msdb) after the others.
    rows.sort((a, b) => Number(isSystem(a.live)) - Number(isSystem(b.live)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const roleText = (r) =>
        r.backup_only_server_id != null
            ? 'backups only'
            : r.role === 'diverged'
              ? 'old primary, out of sync'
              : r.role === 'secondary' && r.restore_delay_minutes > 0
                ? 'secondary (delayed)'
                : r.role;
    const roleBadge = (r) => (r ? badge(roleText(r), r.role === 'diverged' ? 'err' : '') : badge('unmanaged'));
    const stateCell = ({ role, live: d }) => {
        if (!d) return hh?.ok ? badge('not found', 'err') : badge('unknown');
        if (role) return stateBadge(d, role.role);
        return badge(stateText(d, d.state === 'RESTORING' ? 'secondary' : 'primary'), d.state === 'ONLINE' || d.state === 'RESTORING' ? 'ok' : 'warn');
    };
    return dataTable({
        caption: 'Databases on this server',
        rows,
        empty: hh?.ok ? 'No databases on this server.' : 'Not available while the server is unreachable.',
        columns: [
            {
                label: 'Database',
                header: true,
                cell: (x) => [x.role ? h('a', { href: `#/databases/${x.role.database_id}` }, x.name) : x.name, isSystem(x.live) ? [' ', badge('system')] : null],
            },
            { label: 'Role', cell: (x) => roleBadge(x.role) },
            { label: 'Shipping', cell: (x) => (x.role?.role === 'secondary' ? chainBadge(x.role) : '') },
            { label: 'State', cell: stateCell },
            { label: 'Recovery model', cell: (x) => x.live?.recoveryModel ?? '' },
            { label: 'Access', cell: (x) => x.live?.userAccess ?? '' },
        ],
    });
}

export function serverDetailView(id) {
    let root;
    let timer;
    async function load() {
        const [s, roles, info] = await Promise.all([get(`/api/servers/${id}`), get(`/api/servers/${id}/roles`), get('/api/info').catch(() => ({}))]);
        if (s.removed_at) {
            clear(root).append(
                h('h1', `Server ${s.name}`),
                h(
                    'div.callout.warn',
                    `${s.name} was removed on ${formatTime(s.removed_at)}. Mostly-On no longer connects to it; the backup files it wrote stay usable until retention removes them. ` +
                        'To use it again, register a server under the same name (Servers page).',
                ),
            );
            return;
        }
        const hh = s.health;
        // Backups-only databases never move to another server.
        const primaries = roles.filter((r) => r.role === 'primary' && r.backup_only_server_id == null);
        const targets = primaries.length ? await get(`/api/servers/${id}/switchover-targets`).catch(() => null) : null;
        // Native append() would render null as the text "null"; filter it out.
        clear(root).append(...[
            h('h1', `Server ${s.name}`),
            h(
                'div.actions',
                h('button', { type: 'button', onclick: async () => { await post(`/api/servers/${id}/check`); load(); } }, 'Check now'),
                primaries.length ? failoverButton(s, targets) : null,
                h('button', { type: 'button', onclick: async () => { if (await editServerDialog(s)) load(); } }, 'Edit'),
                removeButton(s),
            ),
            hh && !hh.ok ? h('div.callout.err', `Unreachable: ${hh.error}`) : null,
            ...(hh?.warnings || []).map((w) => h('div.callout.warn', w)),
            h(
                'section.panel',
                h(
                    'dl.kv',
                    h('dt', 'Status'), h('dd', healthBadge(s)),
                    h('dt', 'Address'), h('dd.mono', serverAddress(s)),
                    h('dt', 'Version'), h('dd', s.product_version ? `${hh?.info?.versionName || ''} (${s.product_version})` : '–'),
                    h('dt', 'Platform'), h('dd', platformOf(hh?.info?.host)?.long ?? '–'),
                    h('dt', 'Edition'), h('dd', s.edition || '–'),
                    h('dt', 'Backup path (SQL Server)'), h('dd.mono', s.sql_backup_root),
                    h('dt', 'Backup path (Mostly-On)'), h('dd.mono', s.controller_backup_root || `${info.backupRoot ?? 'BACKUP_ROOT'} (default)`),
                    h('dt', 'Default data path'), h('dd.mono', s.default_data_path || '–'),
                    h('dt', 'Default log path'), h('dd.mono', s.default_log_path || '–'),
                    h('dt', 'Last seen'), h('dd', ago(s.last_seen_at)),
                    h('dt', 'Backups and restores at a time'),
                    h('dd', s.work ? `${s.work.limit}${s.max_parallel == null ? ' (default)' : ''}: ${s.work.running} running now${s.work.waiting ? `, ${s.work.waiting} waiting` : ''}` : '–'),
                ),
            ),
            h('h2', 'Setup'),
            h(
                'p.muted',
                `Mostly-On uses a non-privileged service login (without sysadmin). Backups, restores and failovers run through signed helper procedures in master, which are installed through the setup script. `,
            ),
            h(
                'p',
                setupBadge(hh?.setup),
                ' ',
                hh?.setup?.login ? h('span.muted', `Mostly-On uses the login "${hh.setup.login}".`) : null,
            ),
            h('p', h(hh?.setup?.ready ? 'a.button' : 'a.button.primary', { href: `/api/servers/${id}/setup-script`, download: '' }, 'Download setup script')),
            h('h2', 'Databases on this server'),
            serverDatabasesTable(roles, hh),
            hh && !hh.ok ? h('p.muted', 'The server is unreachable, so only the databases Mostly-On manages are listed.') : null,
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
