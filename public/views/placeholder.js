import { h } from '../dom.js';

export function placeholderView(title, text) {
    return {
        render(el) {
            el.append(h('h1', title), h('p.muted', text));
        },
    };
}
