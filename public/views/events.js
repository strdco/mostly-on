import { h, clear, dataTable, badge, timeTag } from '../dom.js';
import { get } from '../api.js';

const LEVEL_KIND = { error: 'err', warn: 'warn', info: '', debug: '' };

/** Who did it: a user, or Mostly-On itself (schedules, log shipping, automatic management). */
export const actorText = (actor) => actor ?? h('span.muted', 'Mostly-On');

export function eventsTable(events, caption = 'Events', limit = 0) {
    return dataTable({
        caption,
        rows: events,
        limit,
        empty: 'No events.',
        columns: [
            { label: 'Time', cell: (e) => timeTag(e.ts) },
            { label: 'Level', cell: (e) => badge(e.level, LEVEL_KIND[e.level]) },
            { label: 'Who', cell: (e) => actorText(e.actor) },
            { label: 'Category', cell: (e) => e.category },
            { label: 'Message', cell: (e) => e.message },
        ],
    });
}

export function eventsView() {
    let container;
    let timer;
    let peopleOnly = false;
    async function load() {
        const events = await get(`/api/events?limit=300${peopleOnly ? '&people_only=1' : ''}`);
        clear(container).append(eventsTable(events, peopleOnly ? 'What people did' : 'Most recent events', 50));
    }
    return {
        async render(el) {
            container = h('div');
            const cb = h('input', { type: 'checkbox', id: 'people-only' });
            cb.addEventListener('change', () => {
                peopleOnly = cb.checked;
                load();
            });
            el.append(
                h('h1', 'Events'),
                h(
                    'div.check',
                    cb,
                    h('label', { for: 'people-only' }, 'Only what people did'),
                    h('span.hint', 'The audit trail: actions started by a user, without what Mostly-On does by itself (scheduled backups, log shipping, checks).'),
                ),
                container,
            );
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'event') return;
            clearTimeout(timer);
            timer = setTimeout(load, 500);
        },
    };
}
