import { h, clear, dataTable, badge, formDialog, field, toast, formatBytes, formatTime, tooltip, menuButton } from '../dom.js';
import { get, post, put } from '../api.js';
import { stateBadge, stateText, ageBadge, expectedMinutes, chainBadge, lagBadge, formatDuration, busyText } from './overview.js';
import { operationsTable } from './operations.js';
import { eventsTable } from './events.js';
import { scheduleDialog, describeSchedule } from './schedule.js';
import { retentionProblem } from './retention.js';
import { lagLimits } from './lag.js';

function editSchedule(db, s) {
    return scheduleDialog({
        title: `${s.backup_type} schedule for ${db.name}`,
        schedule: s,
        onSubmit: (v) => put(`/api/databases/${db.id}/schedules/${s.backup_type}`, v),
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
const MODE_LABEL = { norecovery: 'Not readable (NORECOVERY)', standby: 'Readable between restores (STANDBY)' };

/** The secondary's restore mode, explained for people who do not live in SQL Server. */
function restoreModeFields({ mode = 'norecovery' } = {}) {
    const select = h(
        'select',
        { name: 'restore_mode' },
        h('option', { value: 'norecovery', selected: mode === 'norecovery' }, `${MODE_LABEL.norecovery}, recommended`),
        h('option', { value: 'standby', selected: mode === 'standby' }, `${MODE_LABEL.standby}, for reports`),
    );
    const modeField = field(
        'Secondary copy',
        select,
        'Not readable: nobody can query the copy; it is only there to take over if the primary fails. ' +
            'Readable: people can run read-only queries (reports) on it and see the data as of the last restore. ' +
            'Each time a log is restored (as often as the LOG backups run), anyone using the copy is disconnected and their running queries are cancelled.',
    );
    return { select, fields: [modeField] };
}

/** The mode description for tables. */
function modeText(r) {
    return r.restore_mode === 'standby' ? `${MODE_LABEL.standby}; readers are disconnected at each restore` : MODE_LABEL.norecovery;
}

async function seedDialog(db) {
    // Servers that already hold a copy are handled from their row in the Replicas table (Reinitialize).
    const servers = (await get('/api/servers')).filter((s) => s.enabled && !db.replicas.some((r) => r.server_id === s.id));
    if (!servers.length) {
        toast(`Every server already holds a copy of ${db.name}. Register another SQL Server first (Servers page).`, 'err');
        return null;
    }
    const target = h(
        'select',
        { name: 'server_id', required: true },
        servers.map((s) => h('option', { value: s.id }, s.name)),
    );
    const statusId = `st-${uid()}`;
    const status = h('p.status-text.muted', { id: statusId, role: 'status', 'aria-live': 'polite' });
    target.setAttribute('aria-describedby', statusId);

    const rm = restoreModeFields();
    const mode = rm.select;
    const overwriteBox = h('input', { type: 'checkbox', name: 'overwrite' });
    const confirm = confirmNameInput('confirm');
    const overwrite = h(
        'div.callout.err',
        { hidden: true },
        h('p', h('strong', `${db.name} already exists on this server. `), 'Adding the secondary replaces it. Its data is lost unless you have a backup of it.'),
        field('Overwrite the existing database', overwriteBox),
        field(`Type ${db.name} to confirm`, confirm),
    );


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
            const standbyOk = pf.compat.standby && pf.standbyPath;
            mode.querySelector('option[value=standby]').disabled = !standbyOk;
            if (mode.value === 'standby' && !standbyOk) mode.value = 'norecovery';
            if (!standbyOk) {
                notes.push(
                    !pf.compat.standby
                        ? 'A read-only copy is not possible here: it needs the same SQL Server version on both servers.'
                        : 'A read-only copy is not possible here until the server has a STANDBY folder (edit the server).',
                );
            }
            if (pf.existsOnTarget) {
                overwrite.hidden = false;
                notes.push(
                    pf.existsOnTarget.sameDatabase
                        ? `That server already has an older copy of ${db.name}.`
                        : `That server already has a different database called ${db.name}.`,
                );
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
                radio('source', 'new_full', 'A new FULL backup, taken now (recommended)', true),
                radio('source', 'latest', 'The newest FULL (and DIFF) backup already taken: quicker, no extra load on the primary'),
            ),
            ...rm.fields,
            overwrite,
        ],
        submitLabel: 'Add secondary',
        onSubmit: (v) =>
            post(`/api/databases/${db.id}/secondaries`, {
                server_id: Number(v.server_id),
                source: v.source,
                restore_mode: v.restore_mode,
                overwrite: !overwrite.hidden && v.overwrite,
                confirm: v.confirm,
            }),
    });
}

function settingsDialog(db, r) {
    const rm = restoreModeFields({ mode: r.restore_mode });
    return formDialog({
        title: `Shipping to ${r.server_name}`,
        fields: [...rm.fields, h('p.muted', 'Changes apply from the next log restore.')],
        onSubmit: (v) =>
            put(`/api/databases/${db.id}/replicas/${r.server_id}`, { restore_mode: v.restore_mode }),
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

function previewList(pf) {
    const items = [];
    if (pf.target.error) items.push(h('li.error-text', pf.target.error));
    const n = pf.chain.logsToApply;
    items.push(
        h(
            'li',
            n == null
                ? `Mostly-On could not work out how far behind ${pf.target.name} is.`
                : n === 0
                  ? `${pf.target.name} has restored every log backup taken so far.`
                  : `${pf.target.name} restores ${n} more log backup${n === 1 ? '' : 's'} before it takes over.`,
        ),
    );
    if (pf.chain.gap) items.push(h('li.error-text', `A log backup is missing, so ${pf.target.name} can only be brought up to an earlier point. ${pf.chain.gap}`));
    for (const o of pf.otherSecondaries) items.push(h('li', `${o.server}: ${o.note}.`));
    if (pf.oldPrimaryCanFollow) items.push(h('li.error-text', pf.oldPrimaryCanFollow));
    return h('ul', items);
}

/** What happens to the old primary, for the current state of the tail-log checkbox. */
function tailOutcome(pf, tailLog) {
    const old = pf.oldPrimary.name;
    const since = pf.dataLoss.since ? `${formatTime(pf.dataLoss.since)} (${formatDuration(pf.dataLoss.seconds)} ago)` : 'the last shipped log (time unknown)';
    if (tailLog && pf.plannedPossible) {
        return h('p', `${old} disconnects all users of the database, takes the tail-log backup and becomes the secondary. Nothing is lost.`);
    }
    if (tailLog) {
        return h(
            'div.callout.warn',
            h('strong', 'Data may be lost. '),
            `A failover without data loss is not possible: ${pf.plannedBlocker}. Mostly-On attempts a best-effort tail-log backup on ${old}; transactions committed after ${since} that it cannot capture are lost. `,
            `${old} is then marked out of sync and must be reinitialized from the new primary (Reinitialize).`,
        );
    }
    return h(
        'div.callout.err',
        h('strong', 'Without a tail-log backup, data will be lost. '),
        `Transactions committed on ${old} after ${since} will never reach ${pf.target.name}. `,
        `${old} will be set OFFLINE so nothing can keep writing to it. `,
        pf.plannedPossible ? h('strong', `${old} looks healthy: with the tail-log backup, nothing would be lost.`) : '',
    );
}

async function failoverDialog(db, r) {
    const pf = await get(`/api/databases/${db.id}/failover-preview?server_id=${r.server_id}`);
    const old = pf.oldPrimary.name;
    const outcomeId = `tail-outcome-${r.server_id}`;
    const tail = h('input', { type: 'checkbox', name: 'tail_log', checked: pf.oldPrimary.reachable, 'aria-describedby': outcomeId });
    // Polite live region: unchecking the box announces the data-loss warning.
    const outcome = h('div', { id: outcomeId, 'aria-live': 'polite' });
    const sync = () => clear(outcome).append(tailOutcome(pf, tail.checked));
    tail.addEventListener('change', sync);
    sync();
    const lastCheck = pf.oldPrimary.checkedAt ? ` at the last check (${formatTime(pf.oldPrimary.checkedAt)})` : '';
    return formDialog({
        title: `Fail over ${db.name} to ${r.server_name}`,
        fields: [
            previewList(pf),
            field(
                `Perform tail log backup on ${old}`,
                tail,
                `A final log backup of ${old} that captures the transactions not yet copied to ${r.server_name}. ` +
                    `${old} was ${pf.oldPrimary.reachable ? `reachable (${pf.oldPrimary.state ? stateText({ state: pf.oldPrimary.state, isInStandby: pf.oldPrimary.state === 'STANDBY' }, 'primary') : 'database state unknown'})` : 'unreachable'}${lastCheck}.`,
            ),
            outcome,
        ],
        submitLabel: 'Fail over',
        danger: true,
        onSubmit: (v) =>
            post(`/api/databases/${db.id}/failover`, {
                server_id: r.server_id,
                tail_log: v.tail_log,
                // The dialog showed a data-loss warning; the server refuses a lossy failover without this.
                accept_data_loss: !(v.tail_log && pf.plannedPossible),
            }),
    });
}

function reseedDialog(db, r) {
    const rm = restoreModeFields({ mode: r.restore_mode || 'norecovery' });
    return formDialog({
        title: `Reinitialize ${db.name} on ${r.server_name}`,
        fields: [
            h('p', `The copy on ${r.server_name} is replaced with a fresh copy from the primary, and becomes a working secondary again.`),
            field(
                'Back up the current copy first (safety backup)',
                h('input', { type: 'checkbox', name: 'safety_backup', checked: true }),
                'Recommended. After a failover, the old copy may hold the only record of transactions the new primary never received. ' +
                    'The backup goes to the DIVERGED folder of the backup share and is never deleted automatically. Skipped if the copy cannot be backed up (for example while it is receiving logs).',
            ),
            h(
                'fieldset.choices',
                h('legend', 'Start from'),
                radio('source', 'new_full', 'A new FULL backup, taken now (recommended)', true),
                radio('source', 'latest', 'The newest FULL (and DIFF) backup already taken: quicker, no extra load on the primary'),
            ),
            ...rm.fields,
            field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
        ],
        submitLabel: 'Reinitialize',
        danger: true,
        onSubmit: (v) =>
            post(`/api/databases/${db.id}/replicas/${r.server_id}/reseed`, {
                confirm: v.confirm,
                safety_backup: v.safety_backup,
                source: v.source,
                restore_mode: v.restore_mode,
            }),
    });
}

function takeOfflineDialog(db, r) {
    return formDialog({
        title: `Take the old copy on ${r.server_name} offline?`,
        fields: [
            h('p', `Everyone using ${db.name} on ${r.server_name} is disconnected and the database is set OFFLINE, so no application can keep writing to it. You can still reinitialize it later.`),
            field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
        ],
        submitLabel: 'Take offline',
        danger: true,
        onSubmit: (v) => post(`/api/databases/${db.id}/replicas/${r.server_id}/take-offline`, { confirm: v.confirm }),
    });
}

// --- point-in-time restore ------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** A Date as the value of <input type=datetime-local> (the browser's local time, seconds included). */
function localInputValue(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function offsetText(minutes) {
    const m = Math.abs(minutes);
    return `UTC${minutes < 0 ? '−' : '+'}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The same moment on a server's clock, e.g. "2026-11-21 13:15:00 (UTC+00:00)". */
function serverClock(d, offsetMinutes) {
    const s = new Date(d.getTime() + offsetMinutes * 60_000).toISOString();
    return `${s.slice(0, 10)} ${s.slice(11, 19)} (${offsetText(offsetMinutes)})`;
}

/** A default name for a copy: Sales_20261121_1415 (the moment, local time). */
function copyName(db, d) {
    return `${db.name}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`.slice(0, 100);
}

async function pointInTimeDialog(db) {
    const range = await get(`/api/databases/${db.id}/restore-range`);
    if (!range.from) {
        toast(`${db.name} cannot be restored to a point in time yet: ${range.problem}`, 'err');
        return null;
    }
    const from = new Date(range.from);
    const until = range.untilNow ? new Date(range.now) : new Date(range.to ?? range.from);
    const primaryName = range.primary.name;

    const moment = h('input', {
        type: 'datetime-local',
        name: 'at',
        step: 1,
        required: true,
        min: localInputValue(from),
        max: localInputValue(until),
        value: localInputValue(new Date(Math.max(from.getTime(), until.getTime() - 15 * 60_000))),
    });
    // The moment on the primary's clock, when it differs from this browser's. Not a live
    // region: dragging the slider would announce it at every step.
    const clock = h('p.small.muted');
    const chosen = () => (moment.value ? new Date(moment.value) : null);

    // A slider over the same range, one step per second, kept in sync with the field.
    const toSec = (d) => Math.floor(d.getTime() / 1000);
    const slider = h('input.range', { type: 'range', min: toSec(from), max: toSec(until), step: 1, 'aria-label': 'Moment to restore to' });
    const syncSlider = () => {
        const d = chosen();
        if (d) slider.value = String(toSec(d));
        slider.setAttribute('aria-valuetext', d ? formatTime(d.toISOString()) : 'no moment chosen');
        slider.style.setProperty('--control-value', slider.value);
    };
    slider.addEventListener('input', () => {
        moment.value = localInputValue(new Date(Number(slider.value) * 1000));
        moment.setCustomValidity('');
        sync();
    });
    const sliderBlock = h(
        'div.range-block',
        slider,
        h('div.range-ends.small.muted', { 'aria-hidden': 'true' }, h('span', 'earliest possible'), h('span', range.untilNow ? 'now' : formatTime(range.to ?? range.from))),
    );

    const servers = range.servers.filter((s) => s.ok);
    const preferred = servers.find((s) => s.role === 'secondary') ?? servers[0];
    const serverSelect = h(
        'select',
        { name: 'target_server_id' },
        servers.map((s) => h('option', { value: s.id, selected: s === preferred }, `${s.name}${s.role === 'primary' ? ' (the primary)' : s.role === 'secondary' ? ' (a secondary)' : ''}`)),
    );
    const nameInput = h('input', { type: 'text', name: 'new_name', required: true, maxlength: 100, pattern: '[A-Za-z0-9_][A-Za-z0-9_\\-]*', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' });
    let nameEdited = false;
    nameInput.addEventListener('input', () => {
        nameEdited = true;
    });

    const lost = h('strong');
    const copyGroup = h(
        'fieldset.plain',
        field('Restore it on', serverSelect, 'The copy is a new database next to everything else on that server. Nothing that exists is changed.'),
        field('Name of the copy', nameInput, 'Letters, digits, _ and -. Mostly-On does not back up the copy: drop it when you are done with it.'),
    );
    const secondaries = range.secondaries.map((s) => s.name);
    const rollbackGroup = h(
        'fieldset.plain',
        { hidden: true, disabled: true },
        h(
            'div.callout.err',
            h('p', h('strong', `Every change made to ${db.name} after `), lost, h('strong', ' disappears from the database.')),
            h(
                'ul',
                h('li', `Everyone using ${db.name} on ${primaryName} is disconnected, and it accepts no changes until the rollback is done.`),
                h('li', 'If you might need some of those changes, restore a copy as it is now first, before rolling back.'),
                secondaries.length
                    ? h('li', `${secondaries.join(' and ')} ${secondaries.length === 1 ? 'is restored to the same moment and then continues' : 'are restored to the same moment and then continue'} as usual. A secondary that cannot be restored is marked for reinitializing.`)
                    : null,
            ),
        ),
        field(`Type ${db.name} to confirm`, confirmNameInput('confirm')),
    );

    const modes = h(
        'fieldset.choices',
        h('legend', 'What to do'),
        radio('mode', 'copy', 'Restore a copy under a new name (safe: nothing existing changes)', true),
        radio('mode', 'rollback', `Roll back ${db.name} itself to that moment, on ${primaryName} and every secondary`),
    );

    const sync = () => {
        const d = chosen();
        const rollback = modes.querySelector('input[value=rollback]').checked;
        copyGroup.hidden = copyGroup.disabled = rollback;
        rollbackGroup.hidden = rollbackGroup.disabled = !rollback;
        lost.textContent = d ? formatTime(d.toISOString()) : 'the moment you choose';
        if (d && !nameEdited) nameInput.value = copyName(db, d);
        const offset = range.primary.tz_offset_minutes;
        clear(clock).append(d && offset != null && offset !== -d.getTimezoneOffset() ? `That is ${serverClock(d, offset)} on ${primaryName}'s clock.` : '');
        syncSlider();
    };
    moment.addEventListener('input', sync);
    modes.addEventListener('change', sync);
    sync();

    const span = range.untilNow
        ? `any moment from ${formatTime(range.from)} until now. For a moment after the newest log backup, Mostly-On takes a log backup first.`
        : `any moment from ${formatTime(range.from)} to ${formatTime(range.to ?? range.from)}. ${primaryName} is not reachable, so later moments are not available.`;

    return formDialog({
        title: `Restore ${db.name}`,
        fields: [
            h('p', `Mostly-On can restore ${db.name} to ${span}`),
            field(`Restore to (your time, ${offsetText(-new Date().getTimezoneOffset())})`, moment, 'Date and time, to the second, or drag the slider below.'),
            sliderBlock,
            clock,
            modes,
            copyGroup,
            rollbackGroup,
        ],
        submitLabel: 'Restore',
        onSubmit: (v) => {
            const d = chosen();
            if (!d) throw new Error('Choose the date and time to restore to');
            return v.mode === 'rollback'
                ? post(`/api/databases/${db.id}/point-in-time`, { mode: 'rollback', at: d.toISOString(), confirm: v.confirm })
                : post(`/api/databases/${db.id}/point-in-time`, { mode: 'copy', at: d.toISOString(), target_server_id: Number(v.target_server_id), new_name: v.new_name });
        },
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
            dialogButton('Reinitialize', () => reseedDialog(db, r), 'button.primary'),
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
        ['ok', 'broken'].includes(r.chain_state) ? dialogButton('Failover', () => failoverDialog(db, r), 'button.primary') : null,
        r.chain_state === 'needs_reseed' ? dialogButton('Reinitialize', () => reseedDialog(db, r), 'button.primary') : null,
        ['broken', 'needs_reseed'].includes(r.chain_state)
            ? h('button', { type: 'button', onclick: () => replicaAction(() => post(`/api/databases/${db.id}/replicas/${r.server_id}/recheck`), `Trying ${r.server_name} again`) }, 'Try again')
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

/**
 * The database's own retention days. Empty fields use the global default
 * (shown as placeholder); the same FULL >= DIFF/LOG rule as the server.
 */
function retentionForm(db, settings, reload) {
    const defaults = { full: settings['retention.full_days'], diff: settings['retention.diff_days'], log: settings['retention.log_days'] };
    const own = db.retention?.own || {};
    const input = (key) =>
        h('input', { type: 'number', name: key, min: 1, max: 3650, step: 1, inputmode: 'numeric', value: own[key] ?? '', placeholder: `${defaults[key]} (default)` });
    const inputs = { full: input('full'), diff: input('diff'), log: input('log') };
    const problem = h('p.error-text', { role: 'alert' });
    const save = h('button.primary', { type: 'submit' }, 'Set retention');
    const clearBtn = h('button', { type: 'button' }, 'Revert to defaults');
    const valueOf = (k) => (inputs[k].value === '' ? null : Number(inputs[k].value));
    const submit = async (body) => {
        const effective = { full: body.full_days ?? defaults.full, diff: body.diff_days ?? defaults.diff, log: body.log_days ?? defaults.log };
        problem.textContent = retentionProblem(effective) || '';
        if (problem.textContent) return;
        save.disabled = true;
        try {
            await put(`/api/databases/${db.id}/retention`, body);
            toast(`Retention of ${db.name} saved`, 'ok');
            reload();
        } catch (err) {
            problem.textContent = err.message;
        } finally {
            save.disabled = false;
        }
    };
    const form = h(
        'form.stack.settings-form',
        h(
            'fieldset.retention-days',
            h('legend', 'Keep backups for (days)'),
            field('FULL', inputs.full),
            field('DIFF', inputs.diff),
            field('LOG', inputs.log),
        ),
        problem,
        h('div.actions', save, clearBtn),
    );
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit({ full_days: valueOf('full'), diff_days: valueOf('diff'), log_days: valueOf('log') });
    });
    clearBtn.addEventListener('click', () => {
        for (const i of Object.values(inputs)) i.value = '';
        submit({ full_days: null, diff_days: null, log_days: null });
    });
    return [
        h('h2', 'Backup retention'),
        h('p.muted', `Leave a field empty to use the default (Settings). FULL backups must be kept at least as long as DIFF and LOG backups. Files a secondary still needs, and the newest complete set, are always kept.`),
        form,
    ];
}

const OUTCOME_KIND = { success: 'ok', already_applied: 'ok', running: '', failed: 'err', interrupted: 'warn' };
const OUTCOME_TEXT = { success: 'restored', already_applied: 'already restored', running: 'running', failed: 'failed', interrupted: 'interrupted' };
const ROLE_TEXT = { primary: 'primary', secondary: 'secondary', diverged: 'out of sync' };
const FILE_STATUS = { present: ['on disk', 'ok'], missing: ['missing', 'err'], deleted: ['removed (retention)', ''] };

/** Why a managed database cannot stop being managed right now (null if it can). */
export function stopManagingBlocker(db) {
    const others = db.replicas.filter((r) => r.role !== 'primary');
    if (!others.length) return null;
    return `Remove its secondaries first (${others.map((r) => r.server_name).join(', ')}: Replicas table, Remove).`;
}

/** "Stop managing": typed-name confirmation; resolves to the API result, or null if cancelled. */
export function stopManagingDialog(db) {
    return formDialog({
        title: `Stop managing ${db.name}?`,
        fields: [
            h('p', 'Schedules stop and no more backups or restores run. Nothing is changed on the servers and backup files stay on disk.'),
            field(`Type ${db.name} to confirm`, h('input', { type: 'text', name: 'confirm', required: true, autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false' })),
        ],
        submitLabel: 'Stop managing',
        danger: true,
        onSubmit: (v) => post(`/api/databases/${db.id}/unmanage`, { confirm: v.confirm }),
    });
}

export function databaseView(id) {
    let root;
    let timer;
    let moreOpen = false; // "Show more…" stays as the user left it across live re-renders

    async function backupNow(type) {
        try {
            const r = await post(`/api/databases/${id}/backups`, { type });
            toast(`${r.type} backup started (operation #${r.operation.id})${r.type !== type ? ` instead of ${type}` : ''}`, 'ok');
        } catch (err) {
            toast(err.message, 'err');
        }
    }

    // DIFF and LOG backups build on a FULL: until Mostly-On has one, they are greyed out.
    function backupMenu(db) {
        const noFull = !db.latest.FULL;
        const needsFull = noFull ? 'needs a full backup first' : null;
        return menuButton('Backup', [
            { label: 'Full backup', onSelect: () => backupNow('FULL') },
            { label: 'Differential backup', hint: needsFull, disabled: noFull, onSelect: () => backupNow('DIFF') },
            { label: 'Log backup', hint: needsFull, disabled: noFull, onSelect: () => backupNow('LOG') },
        ]);
    }

    // Disabled (but focusable, with its reason as a tooltip) while other copies exist.
    function stopButton(db) {
        const blocker = stopManagingBlocker(db);
        const button = h('button.danger', { type: 'button', 'aria-disabled': blocker ? 'true' : null }, 'Stop managing');
        const tip = blocker ? tooltip(button, `To stop managing ${db.name}, first remove its secondaries (${db.replicas.filter((r) => r.role !== 'primary').map((r) => r.server_name).join(', ')}) in the Replicas table below.`) : null;
        button.addEventListener('click', async () => {
            if (tip) return tip.show();
            if (await stopManagingDialog(db)) location.hash = '#/';
        });
        return [button, tip?.tip];
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
        const stuckOps = db.operations.filter((o) => o.resumable || o.resolvable);
        // Native append() would render null as the text "null"; h() skips it.
        clear(root).append(
            ...[
            h('h1', db.name),
            h(
                'div.actions',
                backupMenu(db),
                dialogButton('Restore…', () => pointInTimeDialog(db)),
                h(
                    'button.primary',
                    {
                        type: 'button',
                        onclick: async () => {
                            const r = await seedDialog(db).catch((err) => toast(err.message, 'err'));
                            if (r?.operation) toast(`Setting up the secondary (operation #${r.operation.id})`, 'ok');
                        },
                    },
                    'Add secondary',
                ),
                stopButton(db),
            ),
            stopped.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Shipping has stopped for some secondaries, so their copies are getting older. '),
                      h(
                          'ul',
                          stopped.map((r) =>
                              h(
                                  'li',
                                  h('strong', r.server_name),
                                  `: ${r.chain_reason || r.chain_state}`,
                                  r.chain_state === 'broken' ? ' If you can put the missing backup file back, do so and press Try again. Otherwise, reinitialize it (Reinitialize).' : '',
                                  r.chain_state === 'needs_reseed' ? ' This copy cannot catch up any more: reinitialize it (Reinitialize).' : '',
                              ),
                          ),
                      ),
                  )
                : null,
            diverged.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Out-of-sync copies (diverged). '),
                      'After a failover that could not move the old primary over cleanly (no tail-log backup, or the primary was down or damaged), the old primary may hold transactions the new primary never received. ' +
                          'Mostly-On leaves such a copy alone: it never restores onto it or backs it up. Reinitialize it to make it a secondary again; a safety backup of it is taken first.',
                      h(
                          'ul',
                          diverged.map((r) =>
                              h(
                                  'li',
                                  h('strong', r.server_name),
                                  ` is ${r.live ? stateText(r.live, 'diverged') : 'unreachable or missing'}`,
                                  r.live?.state === 'ONLINE' && !r.live.isInStandby
                                      ? ': applications can still write to it, so two servers may be taking changes at once (split brain). Take it offline or reinitialize it.'
                                      : '.',
                              ),
                          ),
                      ),
                  )
                : null,
            unacked.length
                ? h(
                      'div.callout.err',
                      h('strong', 'Backups taken outside Mostly-On were found. '),
                      'Another tool (a maintenance plan, a backup agent, someone running BACKUP by hand) backed up this database. ' +
                          'A LOG backup like that holds transactions the secondaries never receive, so shipping stops. A FULL backup changes what DIFF backups are based on. ' +
                          'Stop the other tool, or make it use COPY_ONLY. Acknowledge each one once you have dealt with it.',
                      h(
                          'ul',
                          unacked.map((f) =>
                              h(
                                  'li',
                                  `${f.type} backup on ${f.server_name} at ${formatTime(f.finish_at)} to `,
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
            db.busy.length ? h('p', badge(`Running now: ${busyText(db.busy, db.replicas)}`)) : null,
            h('h2', 'Replicas'),
            h(
                'p.muted',
                'The primary is the copy your applications use. Secondaries receive its log backups and can take over if it fails (Failover). "Behind" is how old the newest data on a secondary is.',
            ),
            dataTable({
                caption: 'Replicas',
                rows: db.replicas,
                columns: [
                    { label: 'Server', header: true, cell: (r) => h('a', { href: `#/servers/${r.server_id}` }, r.server_name) },
                    { label: 'Role', cell: (r) => ROLE_TEXT[r.role] || r.role },
                    { label: 'State', cell: (r) => stateBadge(r.live, r.role) },
                    { label: 'Reachable', cell: (r) => (r.reachable ? badge('yes', 'ok') : badge('no', 'err')) },
                    {
                        label: 'Shipping',
                        cell: (r) =>
                            r.role === 'primary'
                                ? ''
                                : [
                                      chainBadge(r),
                                      r.lag?.loop?.lastError ? h('div.small.error-text', r.lag.loop.lastError) : null,
                                  ],
                    },
                    {
                        label: 'Copy',
                        cell: (r) => (r.role === 'secondary' ? modeText(r) : ''),
                    },
                    { label: 'Behind', cell: (r) => (r.role === 'secondary' && r.position_lsn ? lagBadge(r.lag, lagLimits(db.schedules.find((s) => s.backup_type === 'LOG'), threshold)) : '') },
                    { label: 'Actions', cell: (r) => replicaActions(db, r, load) },
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
            ...retentionForm(db, settings, load),
            // Failed or interrupted operations stay in view: they are resumed from here.
            stuckOps.length ? h('h2', 'Needs your attention') : null,
            stuckOps.length ? operationsTable(stuckOps, 'Operations that stopped before they finished') : null,
            h(
                'details.more',
                {
                    open: moreOpen,
                    ontoggle: (e) => {
                        moreOpen = e.target.open;
                        e.target.querySelector('.more-label').textContent = moreOpen ? 'Show less' : 'Show more…';
                    },
                },
                h('summary', h('span.more-label', moreOpen ? 'Show less' : 'Show more…'), h('span.small.muted', ' Backup and restore history, operations, events')),
                h('h2', 'Backup history'),
                dataTable({
                    caption: '100 most recent backup files',
                    rows: files,
                    limit: 10,
                    empty: 'No backups yet.',
                    columns: [
                        { label: 'Type', header: true, cell: (f) => f.type + (f.is_tail ? ' (tail-log, from a failover)' : '') },
                        { label: 'Finished', cell: (f) => formatTime(f.backup_finish) },
                        { label: 'File', cell: (f) => h('span.mono', f.rel_path.split('/').pop()) },
                        { label: 'Size', num: true, cell: (f) => formatBytes(f.size_bytes) },
                        { label: 'Status', cell: (f) => badge(...(FILE_STATUS[f.file_status] || [f.file_status, ''])) },
                    ],
                }),
                h('h2', 'Restore history'),
                dataTable({
                    caption: '50 most recent restores on secondaries',
                    rows: restoreRows,
                    limit: 10,
                    empty: 'Nothing restored yet.',
                    columns: [
                        { label: 'Started', header: true, cell: (x) => formatTime(x.started_at) },
                        { label: 'Server', cell: (x) => x.server_name },
                        { label: 'Backup', cell: (x) => [`${x.backup_type} `, h('span.mono', x.rel_path.split('/').pop())] },
                        { label: 'Outcome', cell: (x) => [badge(OUTCOME_TEXT[x.outcome] || x.outcome, OUTCOME_KIND[x.outcome]), x.error ? h('div.small.error-text', x.error) : null] },
                        {
                            label: 'Took',
                            num: true,
                            cell: (x) => (x.finished_at ? formatDuration(Math.round((new Date(x.finished_at) - new Date(x.started_at)) / 1000)) : '–'),
                        },
                        { label: 'Operation', cell: (x) => (x.operation_id ? `#${x.operation_id}` : 'restore loop') },
                    ],
                }),
                h('h2', 'Operations'),
                operationsTable(db.operations, 'Recent operations (excluding routine scheduled backups)', 10),
                h('h2', 'Events'),
                eventsTable(evts, 'Recent events', 10),
            ),
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
