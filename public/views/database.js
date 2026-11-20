import { h, clear, dataTable, badge, formDialog, field, toast, formatBytes, formatTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { stateBadge, ageBadge, expectedMinutes, chainBadge, lagBadge, formatDuration } from './overview.js';
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

const uid = () => Math.random().toString(36).slice(2, 9);

function radio(name, value, label, checked = false) {
    const input = h('input', { type: 'radio', name, value, id: `r-${uid()}`, checked });
    return h('div.check', input, h('label', { for: input.id }, label));
}

function confirmNameInput(name) {
    return h('input', { type: 'text', name, autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' });
}

/** "Add secondary": pick a server, the backup to start from and the restore mode. */
async function seedDialog(db) {
    const servers = (await get('/api/servers')).filter((s) => s.enabled && !db.replicas.some((r) => r.server_id === s.id && r.role === 'primary'));
    if (!servers.length) {
        toast('Register another SQL Server first; every enabled server already holds the primary.', 'err');
        return null;
    }
    const target = h(
        'select',
        { name: 'server_id', required: true },
        servers.map((s) => {
            const rep = db.replicas.find((r) => r.server_id === s.id);
            return h('option', { value: s.id }, rep ? `${s.name} (${rep.role}, ${rep.chain_state}: reseed)` : s.name);
        }),
    );
    const statusId = `st-${uid()}`;
    const status = h('p.status-text.muted', { id: statusId, role: 'status', 'aria-live': 'polite' });
    target.setAttribute('aria-describedby', statusId);

    const mode = h('select', { name: 'restore_mode' }, h('option', { value: 'norecovery' }, 'NORECOVERY (no access)'), h('option', { value: 'standby' }, 'STANDBY (read-only between restores)'));
    const disconnect = field('Disconnect readers before each restore', h('input', { type: 'checkbox', name: 'disconnect_users' }), 'Without this, a reader holding the database delays the restore until it disconnects.');
    const overwriteBox = h('input', { type: 'checkbox', name: 'overwrite' });
    const confirm = confirmNameInput('confirm');
    const overwrite = h(
        'div.callout.err',
        { hidden: true },
        h('p', h('strong', `${db.name} already exists on this server. `), 'Seeding replaces it. Its data is lost unless you have a backup of it.'),
        field('Overwrite the existing database', overwriteBox),
        field(`Type ${db.name} to confirm`, confirm),
    );

    const syncMode = () => {
        disconnect.hidden = mode.value !== 'standby';
    };
    mode.addEventListener('change', syncMode);
    syncMode();

    let check = 0;
    const preflight = async () => {
        const mine = ++check;
        status.textContent = 'Checking the server…';
        overwrite.hidden = true;
        try {
            const pf = await get(`/api/databases/${db.id}/seed-preflight?server_id=${target.value}`);
            if (mine !== check) return;
            const notes = [];
            if (!pf.compat.ok) notes.push(pf.compat.reason);
            else if (pf.compat.reason) notes.push(pf.compat.reason);
            notes.push(`Files go to ${pf.dataPath} (data) and ${pf.logPath} (log).`);
            mode.querySelector('option[value=standby]').disabled = !pf.compat.standby || !pf.standbyPath;
            if (mode.value === 'standby' && (!pf.compat.standby || !pf.standbyPath)) mode.value = 'norecovery';
            syncMode();
            if (pf.existsOnTarget) {
                overwrite.hidden = false;
                notes.push(`${db.name} exists there (${pf.existsOnTarget.standby ? 'STANDBY' : pf.existsOnTarget.state}${pf.existsOnTarget.sameDatabase ? ', same database' : ', a different database'}).`);
            }
            status.textContent = notes.join(' ');
            status.classList.toggle('error-text', !pf.compat.ok);
        } catch (err) {
            if (mine !== check) return;
            status.textContent = err.message;
            status.classList.add('error-text');
        }
    };
    target.addEventListener('change', preflight);
    preflight();

    return formDialog({
        title: `Add a secondary for ${db.name}`,
        fields: [
            field('Target server', target),
            status,
            h(
                'fieldset.choices',
                h('legend', 'Start from'),
                radio('source', 'new_full', 'A fresh FULL backup taken now', true),
                radio('source', 'latest', 'The latest FULL (and DIFF) already on disk'),
            ),
            field('Restore mode', mode),
            disconnect,
            overwrite,
        ],
        submitLabel: 'Start seeding',
        onSubmit: (v) =>
            post(`/api/databases/${db.id}/secondaries`, {
                server_id: Number(v.server_id),
                source: v.source,
                restore_mode: v.restore_mode,
                disconnect_users: v.restore_mode === 'standby' && v.disconnect_users,
                overwrite: !overwrite.hidden && v.overwrite,
                confirm: v.confirm,
            }),
    });
}

function settingsDialog(db, r) {
    const mode = h(
        'select',
        { name: 'restore_mode' },
        h('option', { value: 'norecovery', selected: r.restore_mode === 'norecovery' }, 'NORECOVERY (no access)'),
        h('option', { value: 'standby', selected: r.restore_mode === 'standby' }, 'STANDBY (read-only between restores)'),
    );
    return formDialog({
        title: `Shipping to ${r.server_name}`,
        fields: [
            field('Restore mode', mode, 'Takes effect with the next log restore.'),
            field('Disconnect readers before each restore (STANDBY)', h('input', { type: 'checkbox', name: 'disconnect_users', checked: !!r.disconnect_users })),
        ],
        onSubmit: (v) => put(`/api/databases/${db.id}/replicas/${r.server_id}`, { restore_mode: v.restore_mode, disconnect_users: v.disconnect_users }),
    });
}

function removeDialog(db, r) {
    return formDialog({
        title: `Stop shipping ${db.name} to ${r.server_name}?`,
        fields: [
            h('p', `${r.server_name} is removed from ${db.name}'s replicas and no more logs are restored there. The database on ${r.server_name} is left exactly as it is.`),
            field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
        ],
        submitLabel: 'Remove secondary',
        danger: true,
        onSubmit: (v) => post(`/api/databases/${db.id}/replicas/${r.server_id}/remove`, { confirm: v.confirm }),
    });
}

function previewList(pf, forced) {
    const items = [];
    if (pf.target.error) items.push(h('li.error-text', pf.target.error));
    items.push(h('li', `${pf.target.name} is ${pf.target.state ?? 'unknown'} at LSN ${pf.target.position ?? '?'}; ${pf.chain.logsToApply ?? '?'} log(s) to restore before it takes over.`));
    if (pf.chain.gap) items.push(h('li.error-text', `The log chain stops early: ${pf.chain.gap}`));
    if (forced) {
        items.push(h('li', `Old primary ${pf.oldPrimary.name}: ${pf.oldPrimary.reachable ? `reachable (${pf.oldPrimary.state ?? 'database state unknown'}); a tail-log backup will be attempted` : 'unreachable; no tail-log backup'}.`));
        items.push(h('li', `Afterwards ${pf.oldPrimary.name} is marked diverged and must be reseeded.`));
    } else {
        items.push(h('li', `${pf.oldPrimary.name} takes a tail-log backup (all its users are disconnected) and continues as a secondary.`));
    }
    for (const o of pf.otherSecondaries) items.push(h('li', `${o.server}: ${o.note}.`));
    if (pf.oldPrimaryCanFollow) items.push(h('li.error-text', pf.oldPrimaryCanFollow));
    return h('ul', items);
}

async function failoverDialog(db, r, forced) {
    const pf = await get(`/api/databases/${db.id}/failover-preview?server_id=${r.server_id}`);
    const fields = [];
    if (forced) {
        const since = pf.dataLoss.since ? `${formatTime(pf.dataLoss.since)} (${formatDuration(pf.dataLoss.seconds)} ago)` : 'an unknown time';
        fields.push(
            h(
                'div.callout.err',
                h('strong', 'Data may be lost. '),
                `Transactions committed on ${pf.oldPrimary.name} after ${since} are lost unless the tail-log backup succeeds. `,
                pf.plannedPossible ? h('strong', `${pf.oldPrimary.name} looks healthy: a planned failover would lose nothing.`) : '',
            ),
        );
    } else if (!pf.plannedPossible) {
        fields.push(h('div.callout.warn', 'A planned failover needs the primary ONLINE and a healthy secondary with a complete chain. This one will probably stop at the first step that finds otherwise.'));
    }
    fields.push(previewList(pf, forced));
    if (forced) fields.push(field('I accept that transactions not yet shipped may be lost', h('input', { type: 'checkbox', name: 'accept', required: true })));
    fields.push(field(`Type ${db.name} to confirm`, confirmNameInput('confirm')));
    return formDialog({
        title: `${forced ? 'Forced' : 'Planned'} failover of ${db.name} to ${r.server_name}`,
        fields,
        submitLabel: forced ? 'Force failover' : 'Fail over',
        danger: true,
        onSubmit: (v) => post(`/api/databases/${db.id}/failover`, { server_id: r.server_id, confirm: v.confirm, forced, accept_data_loss: forced && v.accept }),
    });
}

function reseedDialog(db, r) {
    const mode = h('select', { name: 'restore_mode' }, h('option', { value: 'norecovery' }, 'NORECOVERY (no access)'), h('option', { value: 'standby' }, 'STANDBY (read-only between restores)'));
    return formDialog({
        title: `Reseed ${db.name} on ${r.server_name}`,
        fields: [
            h('p', `The copy on ${r.server_name} is replaced by a fresh seed from the primary and becomes a secondary again.`),
            field('Take a COPY_ONLY safety backup of the current copy first', h('input', { type: 'checkbox', name: 'safety_backup', checked: true }), 'Recommended: a diverged copy may hold the only record of transactions the new primary never received. Only possible while it is ONLINE or OFFLINE.'),
            h(
                'fieldset.choices',
                h('legend', 'Start from'),
                radio('source', 'new_full', 'A fresh FULL backup taken now', true),
                radio('source', 'latest', 'The latest FULL (and DIFF) already on disk'),
            ),
            field('Restore mode', mode),
            field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
        ],
        submitLabel: 'Reseed',
        danger: true,
        onSubmit: (v) =>
            post(`/api/databases/${db.id}/replicas/${r.server_id}/reseed`, { confirm: v.confirm, safety_backup: v.safety_backup, source: v.source, restore_mode: v.restore_mode }),
    });
}

function takeOfflineDialog(db, r) {
    return formDialog({
        title: `Take the diverged copy on ${r.server_name} offline?`,
        fields: [
            h('p', `Every session using ${db.name} on ${r.server_name} is disconnected and the database is set OFFLINE, so nothing can write to it. Reseeding it later still works.`),
            field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
        ],
        submitLabel: 'Take offline',
        danger: true,
        onSubmit: (v) => post(`/api/databases/${db.id}/replicas/${r.server_id}/take-offline`, { confirm: v.confirm }),
    });
}

async function replicaAction(fn, okMessage) {
    try {
        await fn();
        if (okMessage) toast(okMessage, 'ok');
    } catch (err) {
        toast(err.message, 'err');
    }
}

function dialogButton(label, open, cls = 'button') {
    return h(
        cls,
        {
            type: 'button',
            onclick: async () => {
                try {
                    const res = await open();
                    if (res?.operation) toast(`Operation #${res.operation.id} started`, 'ok');
                } catch (err) {
                    toast(err.message, 'err');
                }
            },
        },
        label,
    );
}

function replicaActions(db, r, reload) {
    if (r.role === 'primary') return '';
    if (r.role === 'diverged') {
        return h(
            'div.actions',
            dialogButton('Reseed', () => reseedDialog(db, r), 'button.primary'),
            r.live && r.live.state !== 'OFFLINE' ? dialogButton('Take offline', () => takeOfflineDialog(db, r), 'button.danger') : null,
            h(
                'button',
                {
                    type: 'button',
                    onclick: async () => {
                        if (await removeDialog(db, r)) reload();
                    },
                },
                'Remove',
            ),
        );
    }
    return h(
        'div.actions',
        r.chain_state === 'ok' ? dialogButton('Planned failover', () => failoverDialog(db, r, false), 'button.primary') : null,
        ['ok', 'broken'].includes(r.chain_state) ? dialogButton('Forced failover', () => failoverDialog(db, r, true), 'button.danger') : null,
        r.chain_state === 'needs_reseed' ? dialogButton('Reseed', () => reseedDialog(db, r), 'button.primary') : null,
        r.chain_state === 'ok' ? h('button', { type: 'button', onclick: () => replicaAction(() => post(`/api/databases/${db.id}/replicas/${r.server_id}/restore-now`), `Restoring on ${r.server_name}`) }, 'Restore now') : null,
        ['broken', 'needs_reseed'].includes(r.chain_state)
            ? h('button', { type: 'button', onclick: () => replicaAction(() => post(`/api/databases/${db.id}/replicas/${r.server_id}/recheck`), `Rechecking ${r.server_name}`) }, 'Recheck')
            : null,
        h(
            'button',
            {
                type: 'button',
                onclick: async () => {
                    if (await settingsDialog(db, r)) reload();
                },
            },
            'Settings',
        ),
        h(
            'button.danger',
            {
                type: 'button',
                onclick: async () => {
                    if (await removeDialog(db, r)) reload();
                },
            },
            'Remove',
        ),
    );
}

const OUTCOME_KIND = { success: 'ok', already_applied: 'ok', running: '', failed: 'err', interrupted: 'warn' };

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
        const [db, files, evts, restoreRows, settings] = await Promise.all([
            get(`/api/databases/${id}`),
            get(`/api/databases/${id}/backups?limit=100`),
            get(`/api/events?database_id=${id}&limit=50`),
            get(`/api/databases/${id}/restores?limit=50`),
            get('/api/settings'),
        ]);
        const threshold = settings['alerts.lag_threshold_minutes'];
        const stopped = db.replicas.filter((r) => r.role !== 'diverged' && (['broken', 'needs_reseed'].includes(r.chain_state) || (r.chain_state === 'seeding' && r.chain_reason)));
        const diverged = db.replicas.filter((r) => r.role === 'diverged');
        const unacked = db.foreignBackups.filter((f) => !f.acknowledged_at);
        // Native append() would render null as the text "null"; h() skips it.
        clear(root).append(
            ...[
            h('h1', db.name),
            h(
                'div.actions',
                ['FULL', 'DIFF', 'LOG'].map((t) => h('button', { type: 'button', onclick: () => backupNow(t) }, `Back up ${t} now`)),
                h(
                    'button.primary',
                    {
                        type: 'button',
                        onclick: async () => {
                            const r = await seedDialog(db).catch((err) => toast(err.message, 'err'));
                            if (r?.operation) toast(`Seeding started (operation #${r.operation.id})`, 'ok');
                        },
                    },
                    'Add secondary',
                ),
                h('button.danger', { type: 'button', onclick: () => unmanage(db) }, 'Stop managing'),
            ),
            stopped.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Log shipping has stopped for some secondaries. '),
                      h(
                          'ul',
                          stopped.map((r) =>
                              h(
                                  'li',
                                  h('strong', r.server_name),
                                  `: ${r.chain_reason || r.chain_state}`,
                                  r.chain_state === 'broken' ? ' Put the missing file back and press Recheck, or reseed the secondary.' : '',
                                  r.chain_state === 'needs_reseed' ? ' Reseed it.' : '',
                              ),
                          ),
                      ),
                  )
                : null,
            diverged.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Diverged copies. '),
                      'After a forced failover the old primary may hold transactions the new primary never received. Mostly On never restores onto or backs up a diverged copy.',
                      h(
                          'ul',
                          diverged.map((r) =>
                              h(
                                  'li',
                                  h('strong', r.server_name),
                                  ` is ${r.live ? (r.live.isInStandby ? 'STANDBY' : r.live.state) : 'unreachable or missing'}`,
                                  r.live?.state === 'ONLINE' && !r.live.isInStandby ? ': applications can still write to it (split-brain risk). Take it offline or reseed it.' : '. Reseed it to make it a secondary again.',
                              ),
                          ),
                      ),
                  )
                : null,
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
                    {
                        label: 'Shipping',
                        cell: (r) =>
                            r.role === 'primary'
                                ? ''
                                : [chainBadge(r), r.lag?.loop?.lastError ? h('div.small.error-text', r.lag.loop.lastError) : null],
                    },
                    {
                        label: 'Mode',
                        cell: (r) => (r.role === 'primary' ? '' : `${r.restore_mode.toUpperCase()}${r.restore_mode === 'standby' && r.disconnect_users ? ', disconnects readers' : ''}`),
                    },
                    { label: 'Lag', cell: (r) => (r.role === 'secondary' && r.position_lsn ? lagBadge(r.lag, threshold) : '') },
                    { label: 'Position (LSN)', cell: (r) => (r.position_lsn ? h('span.mono', r.position_lsn) : '') },
                    { label: 'Last restore', cell: (r) => (r.role === 'primary' ? '' : formatTime(r.last_restored_at)) },
                    { label: 'Actions', cell: (r) => replicaActions(db, r, load) },
                ],
            }),
            h('h2', 'Restore history'),
            dataTable({
                caption: '50 most recent restores on secondaries',
                rows: restoreRows,
                empty: 'Nothing restored yet.',
                columns: [
                    { label: 'Started', header: true, cell: (x) => formatTime(x.started_at) },
                    { label: 'Server', cell: (x) => x.server_name },
                    { label: 'Backup', cell: (x) => [`${x.backup_type} `, h('span.mono', x.rel_path.split('/').pop())] },
                    { label: 'Outcome', cell: (x) => [badge(x.outcome, OUTCOME_KIND[x.outcome]), x.error ? h('div.small.error-text', x.error) : null] },
                    {
                        label: 'Took',
                        num: true,
                        cell: (x) => (x.finished_at ? formatDuration(Math.round((new Date(x.finished_at) - new Date(x.started_at)) / 1000)) : '–'),
                    },
                    { label: 'Operation', cell: (x) => (x.operation_id ? `#${x.operation_id}` : 'restore loop') },
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
            ].filter((x) => x !== null),
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
                (['database.changed', 'replica.changed', 'restore.finished', 'backup.finished', 'backup.failed', 'foreign.detected'].includes(evt.type) && p.databaseId === id) ||
                (evt.type === 'operation.updated' && p.databaseId === id && p.status !== 'running') ||
                (evt.type === 'event' && p.databaseId === id) ||
                evt.type === 'server.health';
            if (!relevant) return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 400);
        },
    };
}
