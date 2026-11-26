// The signed-in user's own password: as a dialog from the account menu, and as
// a page of its own when someone else chose it (a new account, or a reset).
import { h, formDialog, field, toast } from '../dom.js';
import { post } from '../api.js';

export const MIN_PASSWORD_LENGTH = 8;

/** The fields of a change-password form. The hidden user name tells password managers whose password it is. */
function passwordFields(username) {
    return [
        h('input', { type: 'text', name: 'username', autocomplete: 'username', value: username, hidden: true, readonly: true }),
        field('Current password', h('input', { type: 'password', name: 'current', id: 'current-password', autocomplete: 'current-password', required: true })),
        field(
            'New password',
            h('input', { type: 'password', name: 'password', id: 'new-password', autocomplete: 'new-password', minlength: MIN_PASSWORD_LENGTH, required: true, enterkeyhint: 'done' }),
            `At least ${MIN_PASSWORD_LENGTH} characters. Your browser can suggest a strong one and remember it.`,
        ),
    ];
}

/** From the account menu. Resolves with the new /api/auth/me answer, or null. */
export async function changePasswordDialog(username) {
    const me = await formDialog({
        title: 'Change your password',
        fields: [h('p.muted.small', 'You stay signed in here; anywhere else you are signed in as ' + username + ' signs out.'), ...passwordFields(username)],
        submitLabel: 'Change password',
        onSubmit: (v) => post('/api/auth/password', { current: v.current, password: v.password }),
    });
    if (me) toast('Your password is changed.', 'ok');
    return me;
}

/** Shown instead of the dashboard until the user has chosen their own password. */
export function choosePasswordView({ username, onDone, onSignOut }) {
    return {
        render(el) {
            const err = h('p.error-text', { role: 'alert' });
            const submit = h('button.primary', { type: 'submit' }, 'Save my password');
            const form = h('form.stack', { method: 'post', action: '#' }, passwordFields(username), err, h('div.actions', submit, h('button', { type: 'button', onclick: onSignOut }, 'Sign out')));
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                err.textContent = '';
                submit.disabled = true;
                const fd = new FormData(form);
                try {
                    onDone(await post('/api/auth/password', { current: fd.get('current'), password: fd.get('password') }));
                } catch (ex) {
                    err.textContent = ex.message;
                } finally {
                    submit.disabled = false;
                }
            });
            el.append(
                h(
                    'section.panel.login-panel',
                    h('h1', 'Choose your own password'),
                    h('p', `Welcome, ${username}. Someone else set the password you signed in with, so choose one only you know before you continue.`),
                    form,
                ),
            );
            form.querySelector('#current-password').focus();
        },
    };
}
