// Dashboard shell: auth state, hash router, live updates over SSE.
import { get, post, setCsrf } from './api.js';
import { clear, toast } from './dom.js';
import { loginView } from './views/login.js';
import { serversView, serverDetailView } from './views/servers.js';
import { eventsView } from './views/events.js';
import { overviewView } from './views/overview.js';
import { databaseView } from './views/database.js';
import { operationsView } from './views/operations.js';
import { alertsView } from './views/alerts.js';
import { settingsView } from './views/settings.js';

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
    [/^\/alerts$/, () => alertsView()],
    [/^\/settings$/, () => settingsView()],
];

// --- navigation: inline when the whole row fits, a popover menu when not ----
const topInner = topbar.querySelector('.topbar-inner');
const siteMenu = document.getElementById('site-menu');
const popoverSupported = Object.hasOwn(HTMLElement.prototype, 'popover');
let lastHeaderWidth = 0;

function layoutNav() {
    if (topbar.hidden) return;
    if (!popoverSupported) {
        // Without the Popover API the list would be unreachable: always inline, wrapping if needed.
        siteMenu.removeAttribute('popover');
        topbar.classList.add('is-wide');
        topInner.style.flexWrap = 'wrap';
        return;
    }
    const width = topbar.clientWidth;
    const wide = topbar.classList.contains('is-wide');
    // While collapsed, only a wider header can make the row fit; re-measuring on
    // every shrink would flip the layout back and forth.
    if (!wide && width <= lastHeaderWidth) return;
    lastHeaderWidth = width;
    const wasOpen = siteMenu.matches(':popover-open');
    siteMenu.removeAttribute('popover');
    topbar.classList.add('is-wide');
    const fits = topInner.scrollWidth <= topInner.clientWidth;
    if (!fits) {
        topbar.classList.remove('is-wide');
        siteMenu.setAttribute('popover', 'auto');
        if (wasOpen) siteMenu.showPopover();
    }
}
const navObserver = new ResizeObserver(() => layoutNav());
navObserver.observe(topbar);
navObserver.observe(siteMenu);

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
        announcePage(false);
        return;
    }
    const wasHidden = topbar.hidden;
    topbar.hidden = false;
    if (wasHidden) {
        lastHeaderWidth = 0;
        layoutNav();
    }
    const path = currentPath();
    markNav(path);
    if (siteMenu.matches(':popover-open')) siteMenu.hidePopover();
    for (const [re, make] of routes) {
        const m = re.exec(path);
        if (m) {
            state.current = make(m);
            try {
                await state.current.render(clear(app));
            } catch (err) {
                if (err.status !== 401) toast(err.message, 'err');
            }
            announcePage(navigated);
            navigated = false;
            return;
        }
    }
    location.hash = '#/';
}

// After a route change: a unique title, and focus on the new page's content so
// keyboard and screen reader users start there instead of on the old link.
let navigated = false;
function announcePage(moveFocus) {
    const heading = app.querySelector('h1')?.textContent?.trim();
    document.title = heading ? `${heading} · Mostly-On` : 'Mostly-On';
    if (moveFocus) {
        window.scrollTo(0, 0);
        app.focus({ preventScroll: true });
    }
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

document.getElementById('skip-to-content').addEventListener('click', () => app.focus());

window.addEventListener('hashchange', () => {
    navigated = true;
    render();
});

try {
    const me = await get('/api/auth/me');
    onLogin(me);
} catch {
    render();
}
