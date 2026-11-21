// Tiny DOM helpers. All text goes through textContent; never innerHTML.

/**
 * h('div.panel', {onclick}, 'text', child, [children])
 * Tag may carry .classes and a #id. Attributes starting with "on" become listeners.
 */
export function h(tag, attrs, ...children) {
    const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag);
    const el = document.createElement(name || 'div');
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
        if (part[0] === '.') el.classList.add(part.slice(1));
        else el.id = part.slice(1);
    }
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
        children.unshift(attrs);
        attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export function clear(el) {
    el.replaceChildren();
    return el;
}

/**
 * Responsive data table. columns: [{label, cell:(row)=>node|string, num?:bool, header?:bool}]
 * The first column with header:true is rendered as a row header (<th scope=row>).
 */
export function dataTable({ caption, columns, rows, empty = 'Nothing here yet.' }) {
    const captionId = `cap-${Math.random().toString(36).slice(2, 9)}`;
    if (!rows.length) return h('p.muted', empty);
    return h(
        'div.table-wrapper',
        { tabindex: 0, role: 'region', 'aria-labelledby': captionId },
        h(
            'table.data',
            h('caption', { id: captionId }, caption),
            h('thead', h('tr', columns.map((c) => h('th', { scope: 'col' }, c.label)))),
            h(
                'tbody',
                rows.map((r) =>
                    h(
                        'tr',
                        columns.map((c) =>
                            c.header
                                ? h('th', { scope: 'row' }, c.cell(r))
                                : h(c.num ? 'td.num' : 'td', { 'data-label': c.label }, c.cell(r)),
                        ),
                    ),
                ),
            ),
        ),
    );
}

export function badge(text, kind = '') {
    return h(`span.badge${kind ? '.' + kind : ''}`, text);
}

export function toast(message, kind = '') {
    const box = document.getElementById('toasts');
    const t = h(`div.toast${kind ? '.' + kind : ''}`, message);
    box.append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 10000 : 5000);
}

export function formatBytes(n) {
    if (n === null || n === undefined) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

export function ago(iso) {
    if (!iso) return '–';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 0) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
    return `${(s / 86400).toFixed(1)}d ago`;
}

/** Modal dialog built from a form. Resolves with FormData values or null on dismiss. */
export function formDialog({ title, fields, submitLabel = 'Save', danger = false, onSubmit }) {
    return new Promise((resolve) => {
        const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
        const err = h('p.error-text', { role: 'alert' });
        const form = h(
            'form.stack',
            { method: 'dialog' },
            fields,
            err,
            h(
                'div.actions',
                h('button', { type: 'submit', value: 'cancel', formnovalidate: true, autofocus: danger }, 'Cancel'),
                h(danger ? 'button.danger' : 'button.primary', { type: 'submit', value: 'ok' }, submitLabel),
            ),
        );
        const dlg = h('dialog', { 'aria-labelledby': titleId }, h('h2', { id: titleId }, title), form);
        document.body.append(dlg);
        form.addEventListener('submit', async (e) => {
            if (e.submitter?.value !== 'ok') return; // Cancel: let method=dialog close it
            e.preventDefault();
            err.textContent = '';
            const values = Object.fromEntries(new FormData(form));
            for (const cb of form.querySelectorAll('input[type=checkbox]')) values[cb.name] = cb.checked;
            try {
                const result = onSubmit ? await onSubmit(values) : values;
                dlg.close('ok');
                resolve(result);
            } catch (ex) {
                err.textContent = ex.message;
            }
        });
        dlg.addEventListener('close', () => {
            if (dlg.returnValue !== 'ok') resolve(null);
            dlg.remove();
        });
        dlg.showModal();
    });
}

export function field(label, input, hint) {
    const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
    input.id = id;
    let hintEl = null;
    if (hint) {
        // Screen readers read the hint after the label.
        hintEl = h('span.hint', { id: `${id}-hint` }, hint);
        input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), hintEl.id].filter(Boolean).join(' '));
    }
    if (input.type === 'checkbox') {
        return h('div.check', input, h('label', { for: id }, label), hintEl);
    }
    return h('div.field', h('label', { for: id }, label), input, hintEl);
}
