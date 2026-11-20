import { h } from '../dom.js';
import { post } from '../api.js';

export function loginView({ onLogin }) {
    return {
        render(el) {
            const err = h('p.error-text', { role: 'alert' });
            const submit = h('button.primary', { type: 'submit' }, 'Sign in');
            const form = h(
                'form.stack',
                { method: 'post', action: '#' },
                h(
                    'div.field',
                    h('label', { for: 'username' }, 'User name'),
                    h('input', {
                        type: 'text',
                        id: 'username',
                        name: 'username',
                        autocomplete: 'username',
                        autocapitalize: 'none',
                        autocorrect: 'off',
                        spellcheck: 'false',
                        required: true,
                        autofocus: true,
                    }),
                ),
                h(
                    'div.field',
                    h('label', { for: 'current-password' }, 'Password'),
                    h('input', {
                        type: 'password',
                        id: 'current-password',
                        name: 'password',
                        autocomplete: 'current-password',
                        enterkeyhint: 'done',
                        required: true,
                    }),
                ),
                err,
                submit,
            );
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                err.textContent = '';
                submit.disabled = true;
                const fd = new FormData(form);
                try {
                    const me = await post('/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
                    onLogin(me);
                } catch (ex) {
                    err.textContent = ex.message;
                } finally {
                    submit.disabled = false;
                }
            });
            el.append(h('section.panel.login-panel', h('h1', 'Sign in to cheap-log'), form));
        },
    };
}
