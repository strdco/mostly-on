import { h, clear, dataTable, badge, timeTag, formDialog, field, toast } from '../dom.js';
import { get, post } from '../api.js';
import { actorText } from './events.js';

const STATUS_KIND = { succeeded: 'ok', running: '', queued: '', failed: 'err', interrupted: 'err', resolved: 'warn' };
const STEP_KIND = { done: 'ok', skipped: 'ok', running: '', pending: '', failed: 'err', interrupted: 'err' };

export function opTitle(op) {
    if (op.type === 'backup') return `${op.params.type} backup${op.params.trigger ? ` (${op.params.trigger})` : ''}`;
    if (op.type === 'seed') return `Add secondary${op.params.overwrite ? ' (replacing an existing copy)' : ''}`;
    if (op.type === 'pitr_copy') return ['Restore a copy as it was at ', timeTag(op.params.at), ` (${op.params.newName})`];
    if (op.type === 'pitr_rollback') return ['Roll back to ', timeTag(op.params.at)];
    const titles = {
        reseed: 'Reinitialize',
        planned_failover: 'Failover',
        forced_failover: 'Failover (forced: data may be lost)',
        switchover_all: 'Fail over databases',
    };
    return titles[op.type] || op.type;
}

export async function resumeOperation(op) {
    try {
        await post(`/api/operations/${op.id}/resume`);
        toast(`Operation #${op.id} resumed`, 'ok');
    } catch (err) {
        toast(err.message, 'err');
    }
}

export async function resolveOperation(op) {
    const done = await formDialog({
        title: `Mark operation #${op.id} as resolved?`,
        fields: [
            h('p', 'Use this when you have checked the servers and dealt with the outcome by hand. Mostly-On changes nothing on the servers.'),
            field('Note (optional)', h('input', { type: 'text', name: 'note', maxlength: 500, autocomplete: 'off' })),
        ],
        submitLabel: 'Mark resolved',
        onSubmit: (v) => post(`/api/operations/${op.id}/resolve`, { note: v.note }),
    });
    if (done) toast(`Operation #${op.id} marked as resolved`, 'ok');
    return !!done;
}

function opActions(o) {
    if (!o.resumable && !o.resolvable) return '';
    return h(
        'div.actions',
        o.resumable ? h('button.primary', { type: 'button', onclick: () => resumeOperation(o) }, 'Resume') : null,
        o.resolvable ? h('button', { type: 'button', onclick: () => resolveOperation(o) }, 'Mark resolved') : null,
    );
}

export function stepList(op) {
    return h(
        'ol.steps',
        op.steps.map((s) =>
            h(
                'li',
                badge(s.status, STEP_KIND[s.status]),
                ' ',
                s.label || s.name,
                s.detail ? h('div.muted.mono', s.detail) : null,
                s.error ? h('div.error-text', s.error) : null,
                s.guidance && ['failed', 'interrupted'].includes(s.status) ? h('div.callout.warn', h('strong', 'What to do: '), s.guidance) : null,
            ),
        ),
    );
}

export function operationsTable(rows, caption = 'Operations', limit = 0) {
    return dataTable({
        caption,
        rows,
        limit,
        empty: 'No operations.',
        rowKey: (o) => o.id,
        columns: [
            { label: '#', header: true, cell: (o) => `#${o.id}` },
            { label: 'Operation', cell: (o) => opTitle(o) },
            { label: 'Database', cell: (o) => (o.database_id ? h('a', { href: `#/databases/${o.database_id}` }, o.database_name || `#${o.database_id}`) : '–') },
            { label: 'Status', cell: (o) => badge(o.status, STATUS_KIND[o.status]) },
            {
                label: 'Steps',
                cell: (o) => (o.error ? h('span.error-text', o.error) : o.current_step ? `Running: ${o.current_step}` : `${o.steps.length} step(s)`),
                // The steps open below the operation, across the whole table.
                detail: (o) => (o.steps.length ? stepList(o) : null),
            },
            { label: 'Started', cell: (o) => timeTag(o.created_at) },
            { label: 'Started by', cell: (o) => actorText(o.created_by) },
            { label: 'Finished', cell: (o) => timeTag(o.finished_at) },
            ...(rows.some((o) => o.resumable || o.resolvable) ? [{ label: 'Actions', cell: opActions }] : []),
        ],
    });
}

export function operationsView() {
    let box;
    let includeRoutine = false;
    let timer;
    async function load() {
        const rows = await get(`/api/operations?limit=200${includeRoutine ? '&include_routine=1' : ''}`);
        clear(box).append(operationsTable(rows, 'Recent operations', 25));
    }
    return {
        async render(el) {
            box = h('div');
            const cb = h('input', { type: 'checkbox', id: 'routine' });
            cb.addEventListener('change', () => {
                includeRoutine = cb.checked;
                load();
            });
            el.append(h('h1', 'Operations'), h('div.check', cb, h('label', { for: 'routine' }, 'Include successful scheduled backups')), box);
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'operation.updated') return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 300);
        },
    };
}
