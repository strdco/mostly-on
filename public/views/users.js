// User accounts. Everyone with an account can do everything, including
// managing the other accounts; the event log records who did what.
import { h, clear, dataTable, badge, formatTime, ago, formDialog, field, toast } from '../dom.js';
import { get, post } from '../api.js';
function passwordInput() {
    // Not this browser user's own password: keep password managers from saving or filling it.
    return h('input', { type: 'password', name: 'password', autocomplete: 'off', required: true });
}

const PASSWORD_HINT = 'Give it to them in person or over a channel you trust. They only use it once: at their first sign-in, they choose their own password of at least 8 characters.';

async function addUser() {
    const u = await formDialog({
        title: 'Add a user',
        fields: [
            field(
                'User name',
                h('input', { type: 'text', name: 'username', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', maxlength: 64, pattern: '[A-Za-z0-9_.@\\-]+', required: true }),
                'Letters, digits and _ . @ -, for example their name or e-mail address. It is shown in the event log next to everything they do.',
            ),
            field('First password', passwordInput(), PASSWORD_HINT),
        ],
        submitLabel: 'Add user',
        onSubmit: (v) => post('/api/users', { username: v.username, password: v.password }),
    });
    if (u) toast(`${u.username} can now sign in.`, 'ok');
}

async function resetPassword(u) {
    const done = await formDialog({
        title: `New password for ${u.username}`,
        fields: [h('p', `${u.username} is signed out everywhere, and chooses their own password the next time they sign in.`), field('New password', passwordInput(), PASSWORD_HINT)],
        submitLabel: 'Set password',
        onSubmit: (v) => post(`/api/users/${u.id}/password`, { password: v.password }),
    });
    if (done) toast(`Password of ${u.username} is set.`, 'ok');
}

async function setEnabled(u, enable) {
    if (!enable) {
        const ok = await formDialog({
            title: `Disable ${u.username}?`,
            fields: [h('p', `${u.username} is signed out and can no longer sign in. What they did stays in the event log under their name. You can enable the account again later.`)],
            submitLabel: 'Disable',
            danger: true,
            onSubmit: () => post(`/api/users/${u.id}/disable`),
        });
        if (ok) toast(`${u.username} is disabled.`, 'ok');
        return;
    }
    try {
        await post(`/api/users/${u.id}/enable`);
        toast(`${u.username} can sign in again.`, 'ok');
    } catch (err) {
        toast(err.message, 'err');
    }
}

function status(u) {
    if (u.disabledAt) return badge('disabled', 'warn');
    if (u.mustChangePassword) return badge('chooses password at next sign-in');
    return badge('active', 'ok');
}

export function usersView({ currentUser }) {
    let box;
    let timer;
    async function load() {
        const users = await get('/api/users');
        clear(box).append(
            dataTable({
                caption: 'Users',
                rows: users,
                empty: 'No users.',
                columns: [
                    { label: 'User', header: true, cell: (u) => (u.username === currentUser() ? [u.username, ' ', h('span.muted', '(you)')] : u.username) },
                    { label: 'Status', cell: status },
                    { label: 'Last sign-in', cell: (u) => (u.lastLoginAt ? h('time', { datetime: u.lastLoginAt, title: formatTime(u.lastLoginAt) }, ago(u.lastLoginAt)) : 'Never') },
                    { label: 'Added', cell: (u) => `${formatTime(u.createdAt)}${u.createdBy ? ` by ${u.createdBy}` : ' (first user)'}` },
                    {
                        label: 'Actions',
                        cell: (u) =>
                            u.username === currentUser()
                                ? ''
                                : h(
                                      'div.actions',
                                      u.disabledAt ? null : h('button', { type: 'button', onclick: () => resetPassword(u) }, 'Set password'),
                                      h('button', { type: 'button', onclick: () => setEnabled(u, !!u.disabledAt) }, u.disabledAt ? 'Enable' : 'Disable'),
                                  ),
                    },
                ],
            }),
        );
    }
    return {
        async render(el) {
            box = h('div');
            el.append(
                h('h1', 'Users'),
                h(
                    'p.muted',
                    'Give everyone who works with Mostly-On an account of their own, so the event log shows who did what. Every user can do everything, including adding and disabling users. Accounts are disabled rather than deleted, so their names stay meaningful in the log.',
                ),
                h('div.actions', h('button.primary', { type: 'button', onclick: addUser }, 'Add user')),
                box,
            );
            await load();
        },
        onEvent(evt) {
            if (evt.type !== 'users.changed') return;
            clearTimeout(timer);
            timer = setTimeout(() => load().catch(() => {}), 200);
        },
    };
}
