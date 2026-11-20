import { h, clear, dataTable, badge, formatTime } from '../dom.js';
import { get } from '../api.js';

const STATUS_KIND = { succeeded: 'ok', running: '', queued: '', failed: 'err', interrupted: 'err', resolved: 'warn' };
const STEP_KIND = { done: 'ok', skipped: 'ok', running: '', pending: '', failed: 'err', interrupted: 'err' };

export function opTitle(op) {
    if (op.type === 'backup') return `${op.params.type} backup${op.params.trigger ? ` (${op.params.trigger})` : ''}`;
    return op.type;
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
            ),
        ),
    );
}

export function operationsTable(rows, caption = 'Operations') {
    return dataTable({
        caption,
        rows,
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
        ],
    });
}

export function operationsView() {
    let box;
    let includeRoutine = false;
    let timer;
    async function load() {
        const rows = await get(`/api/operations?limit=200${includeRoutine ? '&include_routine=1' : ''}`);
        clear(box).append(operationsTable(rows, 'Recent operations'));
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
