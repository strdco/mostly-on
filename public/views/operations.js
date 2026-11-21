import { h, clear, dataTable, badge, formatTime, formDialog, field, toast } from '../dom.js';
import { get, post } from '../api.js';

const STATUS_KIND = { succeeded: 'ok', running: '', queued: '', failed: 'err', interrupted: 'err', resolved: 'warn' };
const STEP_KIND = { done: 'ok', skipped: 'ok', running: '', pending: '', failed: 'err', interrupted: 'err' };

export function opTitle(op) {
    if (op.type === 'backup') return `${op.params.type} backup${op.params.trigger ? ` (${op.params.trigger})` : ''}`;
    if (op.type === 'seed') return `Add secondary${op.params.overwrite ? ' (replacing an existing copy)' : ''}`;
    const titles = {
        reseed: 'Reinitialize',
        planned_failover: 'Failover',
        forced_failover: 'Failover (forced: data may be lost)',
        switchover_all: 'Fail over all databases',
    };
    return titles[op.type] || op.type;
}

async function resume(op) {
    try {
        await post(`/api/operations/${op.id}/resume`);
        toast(`Operation #${op.id} resumed`, 'ok');
    } catch (err) {
        toast(err.message, 'err');
    }
}

async function resolve(op) {
    const done = await formDialog({
        title: `Mark operation #${op.id} as resolved?`,
        fields: [
            h('p', 'Use this when you have checked the servers and dealt with the outcome by hand. Mostly On changes nothing on the servers.'),
            field('Note (optional)', h('input', { type: 'text', name: 'note', maxlength: 500, autocomplete: 'off' })),
        ],
        submitLabel: 'Mark resolved',
        onSubmit: (v) => post(`/api/operations/${op.id}/resolve`, { note: v.note }),
    });
    if (done) toast(`Operation #${op.id} marked as resolved`, 'ok');
}

function opActions(o) {
    if (!o.resumable && !o.resolvable) return '';
    return h(
        'div.actions',
        o.resumable ? h('button.primary', { type: 'button', onclick: () => resume(o) }, 'Resume') : null,
        o.resolvable ? h('button', { type: 'button', onclick: () => resolve(o) }, 'Mark resolved') : null,
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
        columns: [
            { label: '#', header: true, cell: (o) => `#${o.id}` },
            { label: 'Operation', cell: (o) => opTitle(o) },
            { label: 'Database', cell: (o) => (o.database_id ? h('a', { href: `#/databases/${o.database_id}` }, o.database_name || `#${o.database_id}`) : '–') },
            { label: 'Status', cell: (o) => badge(o.status, STATUS_KIND[o.status]) },
            {
                label: 'Steps',
                cell: (o) =>
                    h(
                        'details',
                        h('summary', o.error ? h('span.error-text', o.error) : o.current_step ? `Running: ${o.current_step}` : `${o.steps.length} step(s)`),
                        stepList(o),
                    ),
            },
            { label: 'Started', cell: (o) => formatTime(o.created_at) },
            { label: 'Finished', cell: (o) => formatTime(o.finished_at) },
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
