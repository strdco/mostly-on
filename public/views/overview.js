import { h, clear, dataTable, badge, formDialog, toast, ago, tooltip } from '../dom.js';
import { get, post } from '../api.js';
import { activeAlertsCallout } from './alerts.js';
import { stopManagingBlocker, stopManagingDialog } from './database.js';
import { lagLimits } from './lag.js';

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

export function stateBadge(live, role) {
    if (!live) return badge('unknown');
    const expected = role === 'primary' ? live.state === 'ONLINE' : live.state === 'RESTORING' || live.isInStandby;
    return badge(stateText(live, role), expected ? 'ok' : 'err');
}

/** Age badge for a last-backup timestamp against an expected interval (minutes). */
export function ageBadge(iso, expectMinutes) {
    if (!iso) return badge('never', 'warn');
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
 * log backup), plus log backups still waiting, coloured against the database's
 * lag limits (lag.js: its LOG interval plus the alert threshold).
 */
export function lagBadge(lag, limits) {
    if (!lag || lag.seconds === null) return badge('behind: unknown');
    const kind = lag.seconds > limits.alert ? 'err' : lag.seconds > limits.warn ? 'warn' : 'ok';
    const waiting = lag.files ? ` · ${lag.files} log backup${lag.files === 1 ? '' : 's'} to restore` : '';
    return badge(`${formatDuration(lag.seconds)} behind${waiting}`, kind);
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
    for (const r of d.replicas) {
        if (r.role === 'diverged') flag(1, `out-of-sync copy on ${r.server_name} needs reinitializing`);
        if (r.role !== 'secondary') continue;
        if (['broken', 'needs_reseed'].includes(r.chain_state)) flag(2, `shipping to ${r.server_name} stopped`);
        else if (r.chain_state === 'ok' && r.lag?.seconds != null) {
            const limits = lagLimits(d.schedules.find((s) => s.backup_type === 'LOG'), thresholdMinutes);
            if (r.lag.seconds > limits.alert) flag(2, `${r.server_name} is ${formatDuration(r.lag.seconds)} behind`);
            else if (r.lag.seconds > limits.warn) flag(1, `${r.server_name} is ${formatDuration(r.lag.seconds)} behind`);
        }
    }
    for (const t of ['FULL', 'DIFF', 'LOG']) {
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
    if (d.foreignLogBackups) flag(2, 'log backup taken outside Mostly-On');
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

    async function load() {
        const [dbs, discovered, settings, alerts] = await Promise.all([
            get('/api/databases'),
            get('/api/discovered?include_dismissed=1'),
            get('/api/settings'),
            get('/api/alerts?status=active'),
        ]);
        clear(alertsBox).append(...[activeAlertsCallout(alerts)].filter((x) => x !== null));
        const threshold = settings['alerts.lag_threshold_minutes'];
        const health = new Map(dbs.map((d) => [d.id, dbHealth(d, alerts, threshold)]));
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        // Managed databases first, then the ones found on the servers.
        const rows = [
            ...[...dbs].sort(byName).map((d) => ({ managed: true, ...d })),
            ...[...discovered].sort((a, b) => byName(a, b) || a.server_name.localeCompare(b.server_name)).map((d) => ({ managed: false, ...d })),
        ];
        const ifManaged = (fn) => (d) => (d.managed ? fn(d) : '');
        clear(listBox).append(
            dataTable({
                caption: 'Databases',
                rows,
                empty: 'No user databases found on your servers yet. Register a server (Servers page).',
                rowClass: (d) => (d.managed && health.get(d.id).kind !== 'ok' ? `row-${health.get(d.id).kind}` : null),
                columns: [
                    { label: 'Database', header: true, cell: nameCell },
                    {
                        label: 'Health',
                        cell: ifManaged((d) => {
                            const x = health.get(d.id);
                            return [badge(x.label, x.kind), x.reasons.length ? h('ul.health-reasons', x.reasons.map((r) => h('li', r))) : null];
                        }),
                    },
                    {
                        label: 'Primary',
                        cell: (d) => (!d.managed ? d.server_name : d.primary ? [d.primary.server_name, ' ', stateBadge(d.primary.live, 'primary')] : badge('none', 'err')),
                    },
                    {
                        label: 'Secondaries',
                        cell: ifManaged((d) => {
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
                                              ? lagBadge(r.lag, lagLimits(d.schedules.find((s) => s.backup_type === 'LOG'), threshold))
                                              : chainBadge(r),
                                      ),
                                  )
                                : h('span.muted', 'none');
                        }),
                    },
                    ...['FULL', 'DIFF', 'LOG'].map((t) => ({
                        label: `Last ${t}`,
                        cell: ifManaged((d) => ageBadge(d.latest[t]?.backup_finish, expectedMinutes(d.schedules.find((s) => s.backup_type === t)))),
                    })),
                    {
                        label: 'Shipping',
                        cell: ifManaged((d) => {
                            const stopped = d.replicas.filter((r) => ['broken', 'needs_reseed'].includes(r.chain_state));
                            const out = [];
                            if (d.foreignLogBackups) {
                                out.push(badge(`${d.foreignLogBackups} log backup${d.foreignLogBackups === 1 ? '' : 's'} taken outside Mostly-On`, 'err'));
                            }
                            if (stopped.length) out.push(badge(`shipping stopped to ${stopped.map((r) => r.server_name).join(', ')}`, 'err'));
                            return out.length ? out : badge('ok', 'ok');
                        }),
                    },
                    { label: 'Running now', cell: ifManaged((d) => (d.busy.length ? badge(busyText(d.busy, d.replicas)) : '')) },
                ],
            }),
        );
    }

    /** Switch, name (a link for managed databases) and, if the switch cannot be used, why. */
    function nameCell(d) {
        const sw = d.managed
            ? manageSwitch({
                  on: true,
                  label: `Manage ${d.name}`,
                  reason: stopManagingBlocker(d) ? `To stop managing this database, first remove its secondaries (${d.replicas.filter((r) => r.role !== 'primary').map((r) => r.server_name).join(', ')}) on its page.` : null,
                  onActivate: () => stopManaging(d),
              })
            : manageSwitch({
                  on: false,
                  label: `Manage ${d.name} on ${d.server_name}`,
                  reason: d.shippable
                      ? null
                      : `${d.recovery_model} recovery: Mostly-On can only manage databases in FULL recovery. To manage it, run ALTER DATABASE [${d.name}] SET RECOVERY FULL; on ${d.server_name}.`,
                  onActivate: () => manage(d),
              });
        return h('div.db-name', sw, d.managed ? h('a', { href: `#/databases/${d.id}` }, d.name) : h('span', d.name));
    }

    async function manage(d) {
        const res = await formDialog({
            title: `Manage ${d.name}?`,
            fields: [
                h('p', `${d.server_name} becomes the primary for ${d.name}. Mostly-On takes a FULL backup right away and then runs the default schedules (FULL weekly, DIFF daily, LOG every 5 minutes).`),
                h(
                    'p.muted',
                    'From now on, Mostly-On takes all backups of this database. If another tool (a maintenance plan, a backup agent) also takes log backups, the secondaries miss them and shipping stops. ' +
                        'Backups that tools take with the COPY_ONLY option are fine.',
                ),
            ],
            submitLabel: 'Manage',
            onSubmit: () => post('/api/databases', { server_id: d.server_id, name: d.name }),
        });
        if (res) {
            toast(res.warning || `Managing ${d.name}; initial FULL backup started`, res.warning ? 'err' : 'ok');
            load().catch(() => {});
        }
    }

    async function stopManaging(d) {
        if (await stopManagingDialog(d)) {
            toast(`Mostly-On no longer manages ${d.name}`, 'ok');
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
                    'Every user database on your servers. The switch before a name turns management by Mostly-On on or off. ' +
                        'Only databases in the FULL recovery model can be managed (log shipping needs it).',
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
