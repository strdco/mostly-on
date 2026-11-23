import { h, clear, dataTable, badge, tipBadge, formDialog, field, toast, ago, formatTime, tooltip } from '../dom.js';
import { get, post } from '../api.js';
import { activeAlertsCallout } from './alerts.js';
import { stopManagingBlocker, stopManagingDialog } from './database.js';
import { lagLimits, delayText, restoresPaused } from './lag.js';
import { describeSchedule } from './schedule.js';

// As in engine/backup-rules.js (the dashboard does not import engine code).
const ONLY_FULL_MASTER = 'Mostly-On takes only full backups of master, and of databases in SIMPLE or BULK_LOGGED recovery.';

// Database states in words; the SQL Server name stays in brackets where it is a problem.
const STATE_TEXT = {
    ONLINE: 'online',
    RESTORING: 'receiving',
    OFFLINE: 'offline',
    RECOVERING: 'starting up',
    RECOVERY_PENDING: 'cannot start (RECOVERY_PENDING)',
    SUSPECT: 'damaged (SUSPECT)',
    EMERGENCY: 'emergency mode (EMERGENCY)',
};

/** Plain-language state of one copy of a database, coloured by whether it is what its role needs. */
export function stateText(live, role) {
    if (!live) return 'not found';
    if (live.isInStandby) return 'read-only copy';
    if (role === 'primary' && live.state === 'RESTORING') return 'not online (RESTORING)';
    return STATE_TEXT[live.state] || live.state.toLowerCase();
}

function stateExpected(live, role) {
    return role === 'primary' ? live.state === 'ONLINE' && !live.isInStandby : live.state === 'RESTORING' || live.isInStandby;
}

export function stateBadge(live, role) {
    if (!live) return badge('unknown');
    return badge(stateText(live, role), stateExpected(live, role) ? 'ok' : 'err');
}

/**
 * What a copy's state means, for its role (role: primary, secondary or diverged).
 * delayMinutes: the secondary's restore delay (a delayed copy never takes over).
 */
export function stateHelp(live, role, delayMinutes = 0) {
    if (!live) return 'Mostly-On could not read the state of this copy: the server is unreachable, or the database is missing there.';
    const kept = role === 'secondary' && delayMinutes > 0 ? ` It is kept ${delayText(delayMinutes)} behind on purpose (restore delay), so it never takes over in a failover.` : '';
    if (live.isInStandby) return `A read-only copy: people can run read-only queries (reports) on it between restores. Everyone using it is disconnected each time a log backup is restored.${kept}`;
    switch (live.state) {
        case 'ONLINE':
            if (role === 'primary') return 'Online: your applications can read and write it. This is how the primary should be.';
            if (role === 'diverged') return 'Online and writable: applications may be writing to this old copy instead of the primary (split brain). Take it offline or reinitialize it.';
            return 'Online and writable, so it no longer receives log backups from the primary. A secondary should be receiving (RESTORING). Reinitialize it.';
        case 'RESTORING':
            if (role === 'primary') return 'Not online: applications cannot use the database. A failover or restore may have stopped halfway; check Operations.';
            if (role === 'diverged') return 'Restoring and not in use. Reinitialize it to make it a secondary again.';
            if (kept) return `Receiving: SQL Server restores the primary's log backups into this copy. Nobody can query it.${kept}`;
            return 'Receiving: SQL Server restores the primary\'s log backups into this copy. Nobody can query it; it is ready to take over in a failover. This is how a secondary should be.';
        case 'OFFLINE':
            if (role === 'diverged') return 'Offline, so nothing can write to this old copy. Reinitialize it to make it a secondary again.';
            return 'Offline: nobody can use this copy. To bring it back, run ALTER DATABASE … SET ONLINE on that server.';
        case 'RECOVERING':
            return 'Starting up: SQL Server is bringing the database online. This usually takes a moment.';
        case 'RECOVERY_PENDING':
            return 'SQL Server cannot start the database, often because a data or log file is missing or cannot be opened. Check the SQL Server error log.';
        case 'SUSPECT':
            return 'SQL Server found damage and will not open the database. Check the SQL Server error log; fail over, or restore from a backup.';
        case 'EMERGENCY':
            return 'Emergency mode: only sysadmins can read it, for repairs.';
        default:
            return `SQL Server reports the state ${live.state}.`;
    }
}

/** stateBadge() with its meaning as a tooltip. */
export function stateTipBadge(live, role, delayMinutes = 0) {
    if (!live) return tipBadge('unknown', '', stateHelp(live, role, delayMinutes));
    return tipBadge(stateText(live, role), stateExpected(live, role) ? 'ok' : 'err', stateHelp(live, role, delayMinutes));
}

/** Age badge for a last-backup timestamp against an expected interval (minutes; none expected: no colour). */
export function ageBadge(iso, expectMinutes) {
    if (!iso) return badge('never', expectMinutes ? 'warn' : '');
    const mins = (Date.now() - new Date(iso).getTime()) / 60000;
    const kind = !expectMinutes ? '' : mins > expectMinutes * 3 ? 'err' : mins > expectMinutes * 1.5 ? 'warn' : 'ok';
    return badge(ago(iso), kind);
}

export function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '–';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
}

/** What is running on a database, in words (the API reports internal lock names). */
export function busyText(busy, replicas = []) {
    const name = (id) => replicas.find((r) => String(r.server_id) === String(id))?.server_name ?? `server ${id}`;
    const words = {
        full: 'FULL backup',
        diff: 'DIFF backup',
        log: 'LOG backup',
        exclusive: 'failover or reinitialization',
        retention: 'removing old backup files',
    };
    return [...new Set(busy.map((k) => (k.startsWith('restore:') ? `restoring on ${name(k.slice(8))}` : words[k] || k)))].join(', ');
}

const CHAIN = {
    ok: ['shipping', 'ok'],
    seeding: ['being set up', ''],
    broken: ['shipping stopped', 'err'],
    needs_reseed: ['needs reinitializing', 'err'],
};

/** Shipping state of a secondary (catalog chain_state plus the restore loop's retry state). */
export function chainBadge(r) {
    if (r.role === 'diverged') return badge('out of sync', 'err');
    if (r.chain_state === 'ok' && r.lag?.loop?.failures) return badge(`retrying (${r.lag.loop.failures} failed attempt${r.lag.loop.failures === 1 ? '' : 's'})`, 'warn');
    const [text, kind] = CHAIN[r.chain_state] || [r.chain_state, ''];
    return badge(text, kind);
}

/**
 * How far behind the primary a secondary's data is (age of the newest restored
 * log backup), plus log backups still waiting, coloured against its lag limits
 * (lag.js: its LOG interval, its restore delay, plus the alert threshold).
 * rep: the replica, for its pause. Paused: amber, so a pause is not forgotten
 * (the badge also says "paused"). Catching up afterwards: behind on purpose, no colour.
 */
function lagKind(lag, limits, rep) {
    if (restoresPaused(rep)) return 'warn';
    if (rep?.restores_paused_until) return '';
    return lag.seconds > limits.alert ? 'err' : lag.seconds > limits.warn ? 'warn' : 'ok';
}

function lagText(lag, limits, rep) {
    if (limits?.delayMinutes) return `${formatDuration(lag.seconds)} behind · ${restoresPaused(rep) ? 'paused' : `delay ${delayText(limits.delayMinutes)}`}`;
    const waiting = lag.files ? ` · ${lag.files} log backup${lag.files === 1 ? '' : 's'} to restore` : '';
    return `${formatDuration(lag.seconds)} behind${waiting}`;
}

export function lagBadge(lag, limits, rep = null) {
    if (!lag || lag.seconds === null) return badge('behind: unknown');
    return badge(lagText(lag, limits, rep), lagKind(lag, limits, rep));
}

const minutesText = (m) => (m < 60 ? `${m} min` : `${+(m / 60).toFixed(1)} h`);

/** lagBadge() with what it means as a tooltip: where the data ends, and when it counts as too far behind. */
export function lagTipBadge(lag, limits, rep = null) {
    if (!lag || lag.seconds === null) {
        return tipBadge('behind: unknown', '', 'Mostly-On cannot tell yet how far behind this copy is: no log backup has been restored on it yet.');
    }
    const parts = [];
    const delay = limits.delayMinutes;
    if (delay) parts.push(`This copy is kept ${delayText(delay)} behind on purpose (restore delay): it restores a log backup only once that backup is ${delayText(delay)} old.`);
    if (restoresPaused(rep)) parts.push(`Its restores are paused until ${formatTime(rep.restores_paused_until)}, so nobody using it is disconnected meanwhile.`);
    else if (rep?.restores_paused_until) parts.push('It is catching up after a pause or a smaller delay.');
    const finish = lag.lastRestored?.backup_finish;
    parts.push(
        finish
            ? `The newest data on this copy is from ${formatTime(finish)}: when the last log backup restored here was taken.`
            : `The newest data on this copy is ${formatDuration(lag.seconds)} old.`,
    );
    const n = lag.files;
    if (!n) parts.push('Every log backup taken so far has been restored here.');
    else if (delay) parts.push(`${n} newer log backup${n === 1 ? ' is' : 's are'} waiting until ${n === 1 ? 'it is' : 'they are'} old enough.`);
    else parts.push(`${n} newer log backup${n === 1 ? ' is' : 's are'} waiting to be restored.`);
    if (rep?.restores_paused_until) {
        parts.push('No lag alert while its restores are paused or catching up.');
    } else {
        const normalMin = limits.logMinutes + (delay || 0);
        const normal = normalMin ? `Up to ${minutesText(normalMin)} is normal (${delay ? 'its delay plus ' : ''}the time between log backups). ` : '';
        parts.push(`${normal}It turns amber after ${minutesText(limits.warn / 60)}, and red with an alert after ${minutesText(limits.alert / 60)}.`);
    }
    return tipBadge(lagText(lag, limits, rep), lagKind(lag, limits, rep), parts.join(' '));
}

/**
 * A neutral "backups only" tag (engine/backup-rules.js), with what it means as
 * a tooltip. d: a managed database (summary) or a discovered one that would be
 * managed that way (manage_as).
 */
export function backupOnlyTag(d) {
    const what = d.system ? 'A system database' : `In ${d.recovery_model ?? 'SIMPLE'} recovery`;
    const help = d.managed
        ? `${d.system ? 'A system database, backed' : 'Backed'} up on ${d.server_name} only, in the folder ${d.folder} on the backup share. ` +
          'No secondaries, no failover. Mostly-On cannot perform managed restores of system databases.' +
          (d.can_ship ? ' Database is in FULL recovery now: to give it secondaries, stop managing it, then manage it again.' : '')
        : `${what}: Mostly-On would back it up on ${d.server_name} only. No secondaries, no failover, and Mostly-On never restores it.`;
    return tipBadge('backups only', '', help);
}

/**
 * Why a backup type does not apply to a database right now (null if it does):
 * a backups-only database not in FULL recovery, or master (FULL only).
 */
export function typeNotApplicable(d, type) {
    if (d.skipped?.[type]) return d.skipped[type];
    if (d.backup_only && !d.schedules.some((s) => s.backup_type === type)) return d.name === 'master' ? ONLY_FULL_MASTER : `${d.label} has no ${type} schedule.`;
    return null;
}

/** The "Last FULL/DIFF/LOG" cell: its age against the schedule, or why there is none. */
export function lastBackupBadge(d, type) {
    const s = d.schedules.find((x) => x.backup_type === type);
    const at = d.latest[type]?.backup_finish;
    const why = typeNotApplicable(d, type);
    if (why) return tipBadge(at ? ago(at) : 'n/a', '', why); // older backups, from before, stay listed
    if (!s?.enabled && !at) return tipBadge('off', '', `${type} backups are off for this database. Turn them on in its ${type} schedule (database page, Schedules, Edit).`);
    return ageBadge(at, expectedMinutes(s));
}

export function expectedMinutes(schedule) {
    if (!schedule?.enabled) return null;
    if (schedule.kind === 'interval') return schedule.interval_minutes;
    if (schedule.kind === 'daily') return 24 * 60;
    return 7 * 24 * 60;
}

/**
 * Overall health of one database row: 'ok' | 'warn' | 'err', with the reasons
 * in words (colour is never the only signal).
 */
export function dbHealth(d, alerts, thresholdMinutes) {
    const reasons = [];
    let level = 0;
    const flag = (lvl, text) => {
        level = Math.max(level, lvl);
        reasons.push(text);
    };
    if (!d.primary) flag(2, 'no primary');
    else if (d.primary.live && (d.primary.live.state !== 'ONLINE' || d.primary.live.isInStandby)) flag(2, `primary is ${stateText(d.primary.live, 'primary')}`);
    // A log-shipped database out of FULL recovery gets no log backups (an alert says what to do).
    if (!d.backup_only && d.recovery_model && d.recovery_model !== 'FULL') flag(d.recovery_model === 'SIMPLE' ? 2 : 1, `in ${d.recovery_model} recovery: no log backups`);
    for (const r of d.replicas) {
        if (r.role === 'diverged') flag(1, `out-of-sync copy on ${r.server_name} needs reinitializing`);
        if (r.role !== 'secondary') continue;
        if (['broken', 'needs_reseed'].includes(r.chain_state)) flag(2, `shipping to ${r.server_name} stopped`);
        else if (r.chain_state === 'ok' && r.lag?.seconds != null && !r.restores_paused_until) {
            const limits = lagLimits(d.schedules.find((s) => s.backup_type === 'LOG'), thresholdMinutes, r.restore_delay_minutes);
            if (r.lag.seconds > limits.alert) flag(2, `${r.server_name} is ${formatDuration(r.lag.seconds)} behind`);
            else if (r.lag.seconds > limits.warn) flag(1, `${r.server_name} is ${formatDuration(r.lag.seconds)} behind`);
        }
    }
    for (const t of ['FULL', 'DIFF', 'LOG']) {
        if (typeNotApplicable(d, t)) continue;
        const expect = expectedMinutes(d.schedules.find((s) => s.backup_type === t));
        const at = d.latest[t]?.backup_finish;
        if (!expect) continue;
        if (!at) {
            flag(1, `no ${t} backup yet`);
            continue;
        }
        const mins = (Date.now() - new Date(at).getTime()) / 60000;
        if (mins > expect * 3) flag(2, `last ${t} backup ${ago(at)}`);
        else if (mins > expect * 1.5) flag(1, `last ${t} backup ${ago(at)}`);
    }
    // Without secondaries (backups only), a log backup taken elsewhere only matters for a restore by hand.
    if (d.foreignLogBackups) flag(d.backup_only ? 1 : 2, 'log backup taken outside Mostly-On');
    const mine = alerts.filter((a) => a.database_id === d.id);
    if (mine.length) flag(mine.some((a) => a.severity === 'error') ? 2 : 1, `${mine.length} active alert${mine.length === 1 ? '' : 's'}`);
    return { kind: ['ok', 'warn', 'err'][level], label: ['healthy', 'warning', 'error'][level], reasons };
}

/**
 * The manage on/off switch: a checkbox styled as a switch (role=switch; the
 * native `switch` attribute is used where the browser has it). It never flips
 * by itself: activating it opens a dialog, and the list reloads afterwards.
 * A switch that cannot be used stays focusable; its reason is a tooltip (on
 * hover, focus, or a tap on the switch) and its accessible description.
 */
function manageSwitch({ on, label, reason, onActivate }) {
    const input = h('input.switch', {
        type: 'checkbox',
        switch: true,
        role: 'switch',
        checked: on,
        'aria-label': label,
        'aria-disabled': reason ? 'true' : null,
    });
    const tip = reason ? tooltip(input, reason) : null;
    input.addEventListener('click', (e) => {
        e.preventDefault(); // the state changes only once the dialog succeeds
        if (tip) tip.show();
        else onActivate();
    });
    return [input, tip?.tip];
}

export function overviewView() {
    let listBox;
    let alertsBox;
    let timer;

    // Servers whose "Not managed" list is open, so a live re-render keeps it open.
    const openLists = new Set();

    async function load() {
        const [dbs, discovered, settings, alerts, servers] = await Promise.all([
            get('/api/databases'),
            get('/api/discovered?include_dismissed=1'),
            get('/api/settings'),
            get('/api/alerts?status=active'),
            get('/api/servers'),
        ]);
        clear(alertsBox).append(...[activeAlertsCallout(alerts)].filter((x) => x !== null));
        const threshold = settings['alerts.lag_threshold_minutes'];
        const health = new Map(dbs.map((d) => [d.id, dbHealth(d, alerts, threshold)]));

        // One group per server: a log-shipped database under its primary, a
        // backups-only one under its own server, then the databases found
        // there that Mostly-On does not manage. Databases without a primary first.
        const groups = new Map();
        const groupFor = (id, name) => {
            const key = id ?? 'none';
            if (!groups.has(key)) groups.set(key, { key, id, name, server: servers.find((s) => s.id === id) ?? null, managed: [], unmanaged: [] });
            return groups.get(key);
        };
        for (const d of dbs) groupFor(d.primary?.server_id ?? null, d.primary?.server_name).managed.push({ managed: true, ...d, server_name: d.server_name ?? d.primary?.server_name });
        for (const d of discovered) groupFor(d.server_id, d.server_name).unmanaged.push({ managed: false, ...d });
        // System databases after the others.
        const order = (a, b) => Number(!!a.system) - Number(!!b.system) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const sorted = [...groups.values()].sort((a, b) => (a.id == null ? -1 : b.id == null ? 1 : (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' })));

        clear(listBox).append(
            dataTable({
                caption: 'Databases',
                groups: sorted.map((g) => ({ header: groupHeader(g), rows: g.managed.sort(order), footer: notManagedList(g, g.unmanaged.sort(order)) })),
                empty: 'No databases found on your servers yet. Register a server (Servers page).',
                rowClass: (d) => (health.get(d.id).kind !== 'ok' ? `row-${health.get(d.id).kind}` : null),
                columns: [
                    { label: 'Database', header: true, cell: nameCell },
                    {
                        label: 'Health',
                        cell: (d) => {
                            const x = health.get(d.id);
                            return [
                                badge(x.label, x.kind),
                                x.reasons.length ? h('ul.health-reasons', x.reasons.map((r) => h('li', r))) : null,
                                d.busy.length ? h('p.running', `Running: ${busyText(d.busy, d.replicas)}`) : null,
                            ];
                        },
                    },
                    {
                        label: 'Secondaries',
                        cell: (d) => {
                            if (d.backup_only) return backupOnlyTag(d); // why there are none
                            const sec = d.replicas.filter((r) => r.role !== 'primary');
                            return sec.length
                                ? sec.map((r) =>
                                      h(
                                          'div',
                                          r.server_name,
                                          ' ',
                                          stateBadge(r.live, r.role),
                                          ' ',
                                          r.chain_state === 'ok' && r.role === 'secondary' && !r.lag?.loop?.failures
                                              ? lagBadge(r.lag, lagLimits(d.schedules.find((s) => s.backup_type === 'LOG'), threshold, r.restore_delay_minutes), r)
                                              : chainBadge(r),
                                      ),
                                  )
                                : h('span.muted', 'none');
                        },
                    },
                    ...['FULL', 'DIFF', 'LOG'].map((t) => ({ label: `Last ${t}`, cell: (d) => lastBackupBadge(d, t) })),
                ],
            }),
        );
    }

    /** A server's name (a link to its page), and why it needs attention, if it does. */
    function groupHeader(g) {
        if (g.id == null) return h('span.group-name', 'No primary');
        const s = g.server;
        const name = s ? h('a.group-name', { href: `#/servers/${g.id}` }, g.name) : h('span.group-name', g.name);
        const problem = !s ? null : !s.enabled ? badge('disabled') : s.health && !s.health.ok ? badge('unreachable', 'err') : null;
        return [name, problem ? [' ', problem] : null];
    }

    /** The databases found on a server that Mostly-On does not manage: collapsed, with their names in the summary. */
    function notManagedList(g, list) {
        if (!list.length) return null;
        const names = list.map((d) => d.name);
        const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')}, …` : names.join(', ');
        const details = h(
            'details.not-managed',
            { open: openLists.has(g.key) },
            h('summary', `Not managed (${list.length})`, h('span.muted.names', `: ${shown}`)),
            h('ul.not-managed-list', list.map((d) => h('li', nameCell(d)))),
        );
        details.addEventListener('toggle', () => (details.open ? openLists.add(g.key) : openLists.delete(g.key)));
        return details;
    }

    /** Switch, name (a link for managed databases) and, if the switch cannot be used, why. */
    function nameCell(d) {
        const sw = d.managed
            ? manageSwitch({
                  on: true,
                  label: `Manage ${d.label ?? d.name}`,
                  reason: stopManagingBlocker(d) ? `To stop managing this database, first remove its secondaries (${d.replicas.filter((r) => r.role !== 'primary').map((r) => r.server_name).join(', ')}) on its page.` : null,
                  onActivate: () => stopManaging(d),
              })
            : manageSwitch({
                  on: false,
                  label: `Manage ${d.name} on ${d.server_name}`,
                  reason: null,
                  onActivate: () => manage(d),
              });
        // A managed backups-only database shows its tag under Secondaries instead.
        if (d.managed) return h('div.db-name', sw, h('a', { href: `#/databases/${d.id}` }, d.name));
        return h('div.db-name', sw, h('span', d.name), d.manage_as === 'backup_only' ? backupOnlyTag(d) : null);
    }

    let defaults = null; // the default schedules (/api/info), for the Manage dialog
    const scheduleWords = (types) =>
        types
            .map((t) => [t, defaults?.[t]])
            .filter(([, s]) => s && s.enabled !== false)
            .map(([t, s]) => `${t} ${describeSchedule(s)}`)
            .join(', ');

    /** "From now on, only Mostly-On may take log backups", with a required "I understand". */
    function logWarning(consequence) {
        const warningId = `warn-${Math.random().toString(36).slice(2, 9)}`;
        const understand = h('input', { type: 'checkbox', name: 'understand', required: true, 'aria-describedby': warningId });
        const validity = () => understand.setCustomValidity(understand.checked ? '' : 'Tick "I understand" to confirm that no other tool takes log backups of this database.');
        validity();
        understand.addEventListener('change', validity);
        return h(
            'div.callout.warn.ack',
            h(
                'div',
                { id: warningId },
                h('p', h('strong', 'From now on, only Mostly-On may take log backups of this database.')),
                h('p', `If another tool (a maintenance plan, a backup agent) also takes log backups, ${consequence} Backups taken with the COPY_ONLY option are fine.`),
            ),
            field('I understand', understand),
        );
    }

    async function manage(d) {
        if (!defaults) defaults = (await get('/api/info').catch(() => ({}))).defaultSchedules ?? null;
        const local = d.manage_as === 'backup_only';
        const master = d.system && d.name === 'master';
        const logs = d.recovery_model === 'FULL' && !master; // LOG backups (and the warning about them)
        const fields = local
            ? [
                  h(
                      'p',
                      `Mostly-On backs up ${d.name} on ${d.server_name} only: no secondaries, no failover, and no platform-managed restore. ` +
                          `This will take a FULL backup right away, then ${scheduleWords(logs ? ['FULL', 'DIFF', 'LOG'] : ['FULL']) || 'on the default schedules'}.`,
                  ),
                  master
                      ? h('p.muted', ONLY_FULL_MASTER)
                      : logs
                        ? null
                        : h('p.muted', `Mostly-On takes only full backups of databases in SIMPLE or BULK_LOGGED recovery. LOG backups of ${d.name} start by themselves if it is switched to FULL recovery.`),
                  logs
                      ? logWarning('restoring this database to a point in time needs their files as well.')
                      : h('div.callout.note', h('p', 'Turn off other backup jobs for this database, so its backups and their retention live in one place.')),
              ]
            : [
                  h('p', `${d.server_name} becomes the primary for ${d.name}. Mostly-On takes a FULL backup right away and then runs the default schedules (${scheduleWords(['FULL', 'DIFF', 'LOG']) || 'see Settings'}).`),
                  logWarning('the secondaries never get the changes in them, and shipping stops until you reinitialize them.'),
              ];
        const res = await formDialog({
            title: local ? `Back up ${d.name} on ${d.server_name}?` : `Manage ${d.name}?`,
            fields: fields.filter((x) => x !== null),
            submitLabel: local ? 'Back up' : 'Manage',
            onSubmit: () => post('/api/databases', { server_id: d.server_id, name: d.name }),
        });
        if (res) {
            toast(res.warning || `${local ? `Backing up ${d.name} on ${d.server_name}` : `Managing ${d.name}`}; initial FULL backup started`, res.warning ? 'err' : 'ok');
            load().catch(() => {});
        }
    }

    async function stopManaging(d) {
        if (await stopManagingDialog(d)) {
            toast(`Mostly-On no longer manages ${d.label ?? d.name}`, 'ok');
            load().catch(() => {});
        }
    }

    return {
        async render(el) {
            listBox = h('div');
            alertsBox = h('div');
            el.append(
                h('h1', 'Overview'),
                alertsBox,
                h(
                    'p.muted',
                    'Your databases, grouped by server. A database in FULL recovery is listed under its primary and log shipped to its secondaries. ' +
                        'System databases, and databases in SIMPLE or BULK_LOGGED recovery, are only backed up, on their own server.',
                ),
                listBox,
            );
            await load();
        },
        onEvent(evt) {
            if (!['database.changed', 'replica.changed', 'backup.finished', 'backup.failed', 'discovery.changed', 'server.health', 'foreign.detected', 'alert.changed'].includes(evt.type)) return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 400);
        },
    };
}
