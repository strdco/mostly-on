import { h, clear, dataTable, badge, formatTime } from '../dom.js';
import { get } from '../api.js';

const LEVEL_KIND = { error: 'err', warn: 'warn', info: '', debug: '' };

export function eventsTable(events, caption = 'Events') {
    return dataTable({
        caption,
        rows: events,
        empty: 'No events.',
        columns: [
            { label: 'Time', cell: (e) => formatTime(e.ts) },
            { label: 'Level', cell: (e) => badge(e.level, LEVEL_KIND[e.level]) },
            { label: 'Category', cell: (e) => e.category },
            { label: 'Message', cell: (e) => e.message },
        ],
    });
}

export function eventsView() {
    let container;
    let timer;
    async function load() {
        const events = await get('/api/events?limit=300');
        clear(container).append(eventsTable(events, 'Most recent events'));
    }
    return {
        async render(el) {
            container = h('div');
            el.append(h('h1', 'Events'), container);
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'event') return;
            clearTimeout(timer);
            timer = setTimeout(load, 500);
        },
    };
}
