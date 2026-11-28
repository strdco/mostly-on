import { h, clear, dataTable, badge, tipBadge, formDialog, field, toast, ago, tooltip, timeTag } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { stateText, stateBadge, chainBadge } from './overview.js';

/** host:port, or host\INSTANCE for a named instance. */
export function serverAddress(s) {
    return s.instance_name ? `${s.host}\\${s.instance_name}` : `${s.host}:${s.port}`;
}

/**
 * Where a server runs, from its last health check (inspect.js hostOf()):
 * { short: 'Linux container' | 'Linux' | 'Windows' ..., long: 'Ubuntu 24.04, in a container' }, or null.
 * Whether it is in a container is left out while unknown (host.container null).
 */
export function platformOf(host) {
    if (!host?.platform) return null;
    const os = host.platform === 'Windows' ? host.distribution || 'Windows' : [host.distribution, host.release].filter(Boolean).join(' ') || host.platform;
    return {
        short: host.container ? `${host.platform} container` : host.platform,
        long: host.container ? `${os}, in a container (Docker, Kubernetes or similar)` : host.container === false ? `${os}, not in a container` : os,
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
                'Use a new, unprivileged login.',
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
            [
                'The folder all servers back up to, as a path on this server: for example /var/opt/mssql/backup, D:\\Backup or \\\\fileserver\\backup.',
                // Known once a health check has read it (not yet while registering). Only a suggestion: never filled in.
                s.default_backup_path
                    ? [' This server’s own default backup folder is ', h('span.mono', s.default_backup_path), '. Use only if this is the correct shared folder.']
                    : null,
                isEdit ? ' If you change it, run this server’s setup script again.' : null,
            ],
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
                    'Max concurrent backups and restores (optional)',
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

/**
 * Register: connects first, so a typo in the host, port, login or password shows
 * in the dialog, with what to check, before anything is saved.
 */
async function register(v, { signal }) {
    const payload = toPayload(v, false);
    const test = await post('/api/servers/test-connection', payload);
    if (!test.ok) throw new Error(test.error);
    signal.throwIfAborted(); // closed while connecting: register nothing
    return post('/api/servers', payload);
}

export async function editServerDialog(s) {
    const info = await get('/api/info').catch(() => ({}));
    return formDialog({
        title: s ? `Edit server ${s.name}` : 'Register server',
        fields: serverFields(s || {}, info),
        submitLabel: s ? 'Save' : 'Register',
        busyText: s ? null : (v) => `Connecting to ${v.host}…`,
        onSubmit: s ? (v) => put(`/api/servers/${s.id}`, toPayload(v, true)) : register,
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
                    {
                        label: 'Automatic',
                        cell: (s) => {
                            if (!s.auto_manage) return h('span.muted', 'off');
                            const to = servers.find((x) => x.id === s.ship_to_server_id);
                            return tipBadge(
                                to ? `on → ${to.name}` : 'on',
                                '',
                                `${s.name} manages its databases automatically: new user databases are managed by themselves, and dropped ones stop being managed. ` +
                                    (to ? `New databases in FULL recovery are log shipped to ${to.name}.` : 'New databases are backed up only.'),
                            );
                        },
                    },
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
    // Rare: the Register dialog connected a moment ago.
    if (hh && !hh.ok) steps.push(h('li', 'Make sure Mostly-On can connect. It could not: ', h('span.mono', String(hh.error).replace(/\.$/, '')), '.'));
    steps.push(
        h('li', 'Download the setup script. It already has this server’s backup folder and the login ', h('strong', s.username), ' filled in.'),
        h('li', 'Run it on ', h('strong', s.name), ' as a sysadmin, in SSMS, Azure Data Studio or sqlcmd. Running it again later is always safe.'),
        h('li', 'Come back to this page. Within a minute it shows ', h('strong', 'ready'), ' (or press Check now).'),
    );
    await formDialog({
        title: `One more step for ${s.name}`,
        fields: [
            hh?.ok
                ? h('p', `${s.name} is registered, and Mostly-On connected as `, h('strong', s.username), '. Before it can back up or restore there, the setup script has to run once.')
                : h('p', `${s.name} is registered, but Mostly-On cannot back up or restore there until its setup script has been run.`),
            h('p', 'The login needs no permissions of its own: the script grants the few Mostly-On needs, and installs signed procedures in master so it can do its job without sysadmin.'),
            h('ol.steps-list', steps),
        ],
        submitLabel: 'Download setup script',
        cancelLabel: 'Later',
        onSubmit: () => downloadSetupScript(s.id),
    });
}

/** "Switch over all databases on this server to another one", shown with the per-database plan. */
/**
 * "Fail over databases…", always shown so it can be found. Greyed out (reason
 * in a tooltip) when the server is the primary of no log-shipped database,
 * when it is unreachable, or when none of its primaries has a working
 * secondary anywhere.
 */
function failoverButton(s, targets, primaryCount) {
    const blocker = !primaryCount
        ? `${s.name} is not the primary of any log-shipped database, so there is nothing to fail over. Databases fail over from the server that is their primary.`
        : !targets
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

    // A primary is only a primary while it ships to a secondary; without one it is backed up only.
    const roleText = (r) =>
        r.backup_only_server_id != null || (r.role === 'primary' && !r.secondary_names)
            ? 'backups only'
            : r.role === 'diverged'
              ? 'old primary, out of sync'
              : r.role === 'secondary' && r.restore_delay_minutes > 0
                ? 'secondary (delayed)'
                : r.role;
    // A secondary: its shipping state. A primary with secondaries: "shipping", so it
    // stands apart from a primary that is backed up only (no secondaries yet).
    const shippingCell = (r) => {
        if (r?.role === 'secondary') return chainBadge(r);
        if (r?.role === 'primary' && r.secondary_names) return tipBadge('shipping', 'ok', `Log shipped to ${r.secondary_names}. Each secondary's own state is on the database's page.`);
        return '';
    };
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
            { label: 'Shipping', cell: (x) => shippingCell(x.role) },
            { label: 'State', cell: stateCell },
            { label: 'Recovery model', cell: (x) => x.live?.recoveryModel ?? '' },
            { label: 'Access', cell: (x) => x.live?.userAccess ?? '' },
        ],
    });
}

/** The same folder, trailing separators aside (Windows paths ignore case). */
function sameFolder(a, b) {
    const key = (p) => {
        const t = String(p).replace(/[\\/]+$/, '');
        return /^([A-Za-z]:|\\\\)/.test(p) ? t.toLowerCase() : t;
    };
    return key(a) === key(b);
}

/**
 * The server's own default backup folder (SQL Server's setting, read at each
 * health check). Mostly-On never uses it, and never changes the shared backup
 * folder to match it: when the two differ, a note says which one it uses.
 */
function defaultBackupPathCell(s) {
    if (!s.default_backup_path) return '–';
    return [
        h('span.mono', s.default_backup_path),
        sameFolder(s.default_backup_path, s.sql_backup_root)
            ? null
            : h('div.small.muted', 'SQL Server’s own default, for backups taken outside Mostly-On (in SSMS, for example). Mostly-On always uses the backup path above.'),
    ];
}

/** "A, B, C and 9 more": database names for a dialog, without a wall of text. */
function someNames(names, max = 8) {
    if (names.length <= max) return names.join(', ');
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** What automatic management does on this server, in a sentence or two (the switch says whether it is on). */
function autoManageText(s, servers, dropAfter) {
    if (!s.auto_manage) return `New databases on ${s.name} appear on the Overview as not managed, and you manage each one yourself.`;
    const target = servers.find((x) => x.id === s.ship_to_server_id);
    return (
        `Mostly-On manages the user databases on ${s.name} by itself, a minute after they appear, and stops managing one that has been gone for ${dropAfter} minutes. ` +
        (target ? `New databases in FULL recovery are log shipped to ${target.name}.` : 'New databases are backed up only: no server is set to log ship them to.')
    );
}

/**
 * Turns automatic management on, or changes the server new databases are log
 * shipped to, after showing what that does now. Resolves with the saved
 * result, or null if cancelled.
 */
async function autoManageDialog(s, servers, dropAfter) {
    const others = servers.filter((x) => x.id !== s.id && x.enabled && !x.removed_at);
    const target = h(
        'select',
        { name: 'ship_to_server_id' },
        h('option', { value: '' }, 'None: back them up only'),
        others.map((x) => h('option', { value: String(x.id), selected: x.id === s.ship_to_server_id }, x.name)),
    );
    const preview = h('div.callout.note', { 'aria-live': 'polite', hidden: true });
    let seq = 0;
    async function update() {
        const mine = ++seq;
        const p = await get(`/api/servers/${s.id}/auto-manage-preview${target.value ? `?ship_to=${target.value}` : ''}`).catch(() => null);
        if (mine !== seq || !p) return;
        const lines = [];
        if (p.would_manage.length) lines.push(`Mostly-On also starts managing the ${p.would_manage.length} user database${p.would_manage.length === 1 ? '' : 's'} on ${s.name} it does not manage yet: ${someNames(p.would_manage)}.`);
        if (p.paired) {
            lines.push(
                `${p.paired.name} will be configured to log ship back to ${s.name} in case of a failover.` +
                    (p.paired.would_manage.length ? ` Mostly-On also starts managing its ${p.paired.would_manage.length} user database${p.paired.would_manage.length === 1 ? '' : 's'}: ${someNames(p.paired.would_manage)}.` : ''),
            );
        }
        clear(preview).append(...lines.map((t) => h('p', t)));
        preview.hidden = !lines.length;
    }
    target.addEventListener('change', update);
    const res = await formDialog({
        title: s.auto_manage ? `Log shipping of new databases on ${s.name}` : `Manage databases on ${s.name} automatically?`,
        fields: [
            s.auto_manage
                ? null
                : h(
                      'p',
                      `For servers where databases come and go (one per customer, say). A user database is managed a minute after it appears. One that has been gone for ${dropAfter} minutes (Settings) ` +
                          'is no longer managed: its copies on secondaries are dropped, and its backups are kept until retention removes them. System databases, and databases you stopped managing yourself, are left alone.',
                  ),
            field(
                'Log ship new databases to',
                target,
                'Only databases in FULL recovery. Others are backed up on this server only. To have new databases in FULL recovery, set the model database to FULL recovery.',
            ),
            preview,
        ].filter((x) => x !== null),
        submitLabel: s.auto_manage ? 'Save' : 'Turn on',
        onOpen: () => update(),
        onSubmit: (v) => put(`/api/servers/${s.id}/auto-manage`, { auto_manage: true, ship_to_server_id: v.ship_to_server_id ? Number(v.ship_to_server_id) : null }),
    });
    if (res) toast(res.paired ? `Saved. ${res.paired} now log ships its new databases to ${s.name}.` : 'Saved', 'ok');
    return res;
}

/** The on/off switch for automatic management, its explanation, and (while on) a button to change the target. */
function autoManageSection(s, servers, dropAfter, reload) {
    const id = `am-${s.id}`;
    const sw = h('input.switch', { type: 'checkbox', switch: true, role: 'switch', id, checked: s.auto_manage, 'aria-describedby': `${id}-hint` });
    sw.addEventListener('change', async () => {
        sw.disabled = true;
        try {
            if (sw.checked) {
                if (!(await autoManageDialog(s, servers, dropAfter))) sw.checked = false; // cancelled
            } else {
                await put(`/api/servers/${s.id}/auto-manage`, { auto_manage: false });
                toast(`${s.name} no longer manages its databases automatically`, 'ok');
            }
        } catch (err) {
            sw.checked = !sw.checked;
            toast(err.message, 'err');
        } finally {
            sw.disabled = false;
        }
        reload();
    });
    return h(
        'section.panel',
        h('div.setting-switch', sw, h('label', { for: id }, 'Manage databases automatically'), h('span.hint', { id: `${id}-hint` }, autoManageText(s, servers, dropAfter))),
        s.auto_manage
            ? h('p.auto-target', h('button', { type: 'button', onclick: async () => { if (await autoManageDialog(s, servers, dropAfter)) reload(); } }, 'Change where new databases are shipped'))
            : null,
    );
}

export function serverDetailView(id) {
    let root;
    let timer;
    async function load() {
        const [s, roles, info, servers, settings] = await Promise.all([
            get(`/api/servers/${id}`),
            get(`/api/servers/${id}/roles`),
            get('/api/info').catch(() => ({})),
            get('/api/servers'),
            get('/api/settings').catch(() => ({})),
        ]);
        const dropAfter = settings['auto_manage.drop_after_minutes'] ?? 30;
        if (s.removed_at) {
            clear(root).append(
                h('h1', `Server ${s.name}`),
                h(
                    'div.callout.warn',
                    `${s.name} was removed on `,
                    timeTag(s.removed_at),
                    '. Mostly-On no longer connects to it; the backup files it wrote stay usable until retention removes them. ' +
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
                failoverButton(s, targets, primaries.length),
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
                    h('dt', 'Default backup path'), h('dd', defaultBackupPathCell(s)),
                    h('dt', 'Last seen'), h('dd', ago(s.last_seen_at)),
                    h('dt', 'Max concurrent operations'),
                    h('dd', s.work ? `${s.work.limit}${s.max_parallel == null ? ' (default)' : ''}: ${s.work.running} running now${s.work.waiting ? `, ${s.work.waiting} waiting` : ''}` : '–'),
                ),
            ),
            h('h2', 'Automatic management'),
            autoManageSection(s, servers, dropAfter, () => load().catch(() => {})),
            h('h2', 'Setup'),
            h(
                'p.muted',
                `Mostly-On uses an unprivileged service login. Backups, restores and failovers run through signed helper procedures in master. `,
            ),
            h(
                'p',
                setupBadge(hh?.setup),
                ' ',
                hh?.setup?.login ? h('span.muted', `Mostly-On uses the SQL Server login "${hh.setup.login}".`) : null,
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
