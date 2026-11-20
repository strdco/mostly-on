// Dashboard shell: auth state, hash router, live updates over SSE.
import { get, post, setCsrf } from './api.js';
import { clear, toast } from './dom.js';
import { loginView } from './views/login.js';
import { serversView, serverDetailView } from './views/servers.js';
import { eventsView } from './views/events.js';
import { placeholderView } from './views/placeholder.js';
import { overviewView } from './views/overview.js';
import { databaseView } from './views/database.js';
import { operationsView } from './views/operations.js';

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const liveIndicator = document.getElementById('live-indicator');

const state = { user: null, stream: null, current: null };

// route table: [regex, view(params) => {render(el), onEvent?(evt)}]
const routes = [
    [/^\/$/, () => overviewView()],
    [/^\/databases\/(\d+)$/, (m) => databaseView(Number(m[1]))],
    [/^\/servers$/, () => serversView()],
    [/^\/servers\/(\d+)$/, (m) => serverDetailView(Number(m[1]))],
    [/^\/events$/, () => eventsView()],
    [/^\/operations$/, () => operationsView()],
    [/^\/settings$/, () => placeholderView('Settings', 'Settings UI arrives in a later phase.')],
];

function currentPath() {
    return location.hash.replace(/^#/, '') || '/';
}

function markNav(path) {
    for (const a of topbar.querySelectorAll('nav a')) {
        const target = a.getAttribute('href').slice(1);
        const active = target === '/' ? path === '/' : path.startsWith(target);
        if (active) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
}

async function render() {
    if (!state.user) {
        topbar.hidden = true;
        state.current = loginView({ onLogin });
        await state.current.render(clear(app));
        return;
    }
    topbar.hidden = false;
    const path = currentPath();
    markNav(path);
    for (const [re, make] of routes) {
        const m = re.exec(path);
        if (m) {
            state.current = make(m);
            try {
                await state.current.render(clear(app));
            } catch (err) {
                if (err.status !== 401) toast(err.message, 'err');
            }
            return;
        }
    }
    location.hash = '#/';
}

function connectStream() {
    if (state.stream) return;
    const es = new EventSource('/api/stream');
    state.stream = es;
    es.onopen = () => {
        liveIndicator.textContent = 'live';
        liveIndicator.classList.add('on');
    };
    es.onerror = () => {
        liveIndicator.textContent = 'reconnecting';
        liveIndicator.classList.remove('on');
    };
    const dispatch = (e) => {
        let evt;
        try {
            evt = JSON.parse(e.data);
        } catch {
            return;
        }
        state.current?.onEvent?.(evt);
    };
    for (const type of ['event', 'server.health', 'database.changed', 'replica.changed', 'backup.finished', 'restore.finished', 'operation.updated', 'alert.changed', 'backup.failed', 'discovery.changed', 'foreign.detected']) {
        es.addEventListener(type, dispatch);
    }
}

function disconnectStream() {
    state.stream?.close();
    state.stream = null;
    liveIndicator.textContent = 'offline';
    liveIndicator.classList.remove('on');
}

function onLogin(me) {
    state.user = me.user;
    setCsrf(me.csrfToken);
    connectStream();
    render();
}

document.getElementById('logout').addEventListener('click', async () => {
    try {
        await post('/api/auth/logout');
    } catch {
        /* session may already be gone */
    }
    state.user = null;
    setCsrf(null);
    disconnectStream();
    render();
});

window.addEventListener('auth-required', () => {
    if (!state.user) return;
    state.user = null;
    disconnectStream();
    toast('Your session has ended. Please sign in again.');
    render();
});

window.addEventListener('hashchange', render);

try {
    const me = await get('/api/auth/me');
    onLogin(me);
} catch {
    render();
}
