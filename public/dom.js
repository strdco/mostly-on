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
// Tables the user expanded with "Show all", by caption, so a live re-render keeps them open.
const expandedTables = new Set();

const isEmpty = (v) => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && v.every(isEmpty));

/**
 * A table that stacks into cards in narrow containers.
 * @param {object} o
 * @param {number} [o.limit]  show this many rows, with a "Show all" toggle for the rest
 * @param {(row) => string} [o.rowClass]
 */
export function dataTable({ caption, columns, rows, empty = 'Nothing here yet.', limit = 0, rowClass = null }) {
    const captionId = `cap-${Math.random().toString(36).slice(2, 9)}`;
    if (!rows.length) return h('p.muted', empty);
    const extra = limit && rows.length > limit + 2 ? rows.length - limit : 0; // don't hide just one or two rows
    let open = expandedTables.has(caption);
    const trs = rows.map((r, i) =>
        h(
            'tr',
            { class: rowClass?.(r) || null, hidden: extra > 0 && !open && i >= limit },
            columns.map((c) => {
                const content = c.cell(r);
                if (c.header) return h('th', { scope: 'row' }, content);
                return h(c.num ? 'td.num' : 'td', { 'data-label': c.label, 'data-empty': isEmpty(content) }, content);
            }),
        ),
    );
    const table = h(
        'div.table-wrapper',
        { tabindex: 0, role: 'region', 'aria-labelledby': captionId },
        h('table.data', h('caption', { id: captionId }, caption), h('thead', h('tr', columns.map((c) => h('th', { scope: 'col' }, c.label)))), h('tbody', trs)),
    );
    if (!extra) return table;
    // The toggle stays in place (and keeps focus) in both states.
    const label = () => (open ? `Show the first ${limit}` : `Show all ${rows.length}`);
    const toggle = h('button.link', { type: 'button', 'aria-expanded': String(open) }, label());
    toggle.addEventListener('click', () => {
        open = !open;
        if (open) expandedTables.add(caption);
        else expandedTables.delete(caption);
        trs.forEach((tr, i) => (tr.hidden = !open && i >= limit));
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = label();
    });
    return h('div', table, h('p.table-more', toggle));
}

export function badge(text, kind = '') {
    return h(`span.badge${kind ? '.' + kind : ''}`, text);
}

/**
 * A badge that explains itself: a button whose only job is to show `help` as a
 * tooltip (on hover, focus, click or tap). Returns [button, tip] for one cell.
 */
export function tipBadge(text, kind, help) {
    const button = h(`button.badge.has-tip${kind ? '.' + kind : ''}`, { type: 'button' }, text);
    return [button, tooltip(button, help, { toggle: true }).tip];
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

const pad2 = (n) => String(n).padStart(2, '0');

/** A moment in the browser's local time, ISO style: "2026-11-21 14:03:09". */
export function formatTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '–';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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

/**
 * Modal dialog built from a form. Resolves with FormData values or null on dismiss.
 * onOpen({ form, submit }) runs before it opens, e.g. to set aria-disabled on the
 * submit button while the form cannot be sent (it stays focusable; the form refuses it).
 */
export function formDialog({ title, fields, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, onSubmit, onOpen }) {
    return new Promise((resolve) => {
        const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
        const err = h('p.error-text', { role: 'alert' });
        const submit = h(danger ? 'button.danger' : 'button.primary', { type: 'submit', value: 'ok' }, submitLabel);
        const form = h(
            'form.stack',
            { method: 'dialog' },
            fields,
            err,
            h('div.actions', h('button', { type: 'submit', value: 'cancel', formnovalidate: true, autofocus: danger }, cancelLabel), submit),
        );
        const dlg = h('dialog', { 'aria-labelledby': titleId }, h('h2', { id: titleId }, title), form);
        document.body.append(dlg);
        form.addEventListener('submit', async (e) => {
            if (e.submitter?.value !== 'ok') return; // Cancel: let method=dialog close it
            e.preventDefault();
            if (submit.getAttribute('aria-disabled') === 'true') return;
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
        onOpen?.({ form, submit });
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

let tipSeq = 0;

/**
 * A tooltip on `trigger`: shown on hover and keyboard focus (and by calling
 * show(), e.g. when a disabled control is tapped), hidden on leaving, blur or
 * Escape; the pointer can move onto it without it closing. It is a manual
 * popover (top layer, so table wrappers never clip it) positioned by script,
 * and is the trigger's accessible description even while hidden.
 * With toggle (a button whose only job is the tooltip, see tipBadge()), a click
 * or tap shows it too, and the trigger's aria-expanded says whether it is open
 * instead of the tooltip being its description.
 * Returns { tip, show }: put `tip` right after the trigger in the DOM.
 */
export function tooltip(trigger, text, { toggle = false } = {}) {
    const tip = h('div.tooltip', { id: `tip-${++tipSeq}`, role: 'tooltip', popover: 'manual' }, text);
    if (toggle) trigger.setAttribute('aria-expanded', 'false');
    else trigger.setAttribute('aria-describedby', [trigger.getAttribute('aria-describedby'), tip.id].filter(Boolean).join(' '));
    const popover = typeof tip.showPopover === 'function';
    let hideTimer = null;

    const place = () => {
        const r = trigger.getBoundingClientRect();
        const t = tip.getBoundingClientRect();
        const gap = 8;
        const top = r.top - t.height - gap >= gap ? r.top - t.height - gap : r.bottom + gap;
        const left = Math.min(Math.max(gap, r.left), window.innerWidth - t.width - gap);
        tip.style.top = `${Math.round(top)}px`;
        tip.style.left = `${Math.round(Math.max(gap, left))}px`;
    };
    const onKey = (e) => {
        if (e.key === 'Escape') hide(0);
    };
    function show() {
        clearTimeout(hideTimer);
        if (!tip.isConnected) return;
        tip.classList.add('open');
        if (popover && !tip.matches(':popover-open')) tip.showPopover();
        place();
        if (toggle) trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', onKey);
    }
    function hide(delay = 150) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            tip.classList.remove('open');
            if (popover && tip.matches(':popover-open')) tip.hidePopover();
            if (toggle) trigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('keydown', onKey);
        }, delay);
    }
    if (toggle) trigger.addEventListener('click', show);
    trigger.addEventListener('mouseenter', show);
    trigger.addEventListener('mouseleave', () => hide());
    trigger.addEventListener('focus', show);
    trigger.addEventListener('blur', () => hide(0));
    tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tip.addEventListener('mouseleave', () => hide());
    return { tip, show };
}

let menuSeq = 0;

/**
 * A button that opens a popup menu of commands: an auto popover (light
 * dismiss, Escape) placed below the button by script. Arrow keys, Home and
 * End move between items; opening from the keyboard (Enter, Space,
 * ArrowDown) focuses the first usable item; closing returns focus to the
 * button. Items: [{ label, hint?, disabled?, onSelect }]; a disabled item
 * stays reachable (aria-disabled) so its hint is read out.
 * Returns [button, menu]: keep them next to each other.
 */
export function menuButton(label, items, { className = '' } = {}) {
    const id = `menu-${++menuSeq}`;
    const trigger = h(`button${className}`, { type: 'button', id: `${id}-trigger`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id }, label, h('span.menu-caret', { 'aria-hidden': 'true' }, ' ▾'));
    const buttons = items.map((it) =>
        h(
            'button',
            { type: 'button', role: 'menuitem', tabindex: '-1', 'aria-disabled': it.disabled ? 'true' : null },
            h('span', it.label),
            it.hint ? h('span.menu-hint', it.hint) : null,
        ),
    );
    const menu = h('div.menu', { id, popover: 'auto', role: 'menu', 'aria-labelledby': trigger.id }, buttons);
    const usable = () => buttons.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    const isOpen = () => menu.matches(':popover-open');
    let enterOnOpen = false;

    const place = () => {
        const r = trigger.getBoundingClientRect();
        const m = menu.getBoundingClientRect();
        const gap = 4;
        const below = r.bottom + gap + m.height <= window.innerHeight - 8 || r.top - gap - m.height < 8;
        menu.style.top = `${Math.round(below ? r.bottom + gap : r.top - gap - m.height)}px`;
        menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8)))}px`;
    };
    const open = (enter) => {
        enterOnOpen = enter;
        if (!isOpen()) menu.showPopover();
        else if (enter) (usable()[0] ?? buttons[0])?.focus();
    };
    const close = ({ restore = true, fromPointer = false } = {}) => {
        if (restore) trigger.focus({ focusVisible: !fromPointer });
        if (isOpen()) menu.hidePopover();
    };

    menu.addEventListener('toggle', (e) => {
        const opened = e.newState === 'open';
        trigger.setAttribute('aria-expanded', String(opened));
        if (opened) {
            place();
            if (enterOnOpen) (usable()[0] ?? buttons[0])?.focus();
        } else if (menu.contains(document.activeElement)) {
            trigger.focus();
        }
    });
    trigger.addEventListener('click', (e) => {
        if (isOpen()) return close({ fromPointer: e.detail > 0 });
        open(e.detail === 0); // detail 0: Enter or Space, so enter the menu
    });
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            open(true);
        }
    });
    menu.addEventListener('keydown', (e) => {
        const i = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const n = buttons.length;
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + n) % n;
            buttons[next].focus();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'Tab') {
            close({ restore: false });
        }
    });
    buttons.forEach((b, i) => {
        b.addEventListener('pointermove', () => b !== document.activeElement && b.focus({ focusVisible: false }));
        b.addEventListener('click', (e) => {
            if (b.getAttribute('aria-disabled') === 'true') return;
            close({ fromPointer: e.detail > 0 });
            items[i].onSelect();
        });
    });
    return [trigger, menu];
}
