// Dashboard shell: auth state, hash router, live updates over SSE.
import { get, post, setCsrf } from './api.js';
import { h, clear, toast, menuButton } from './dom.js';
import { loginView } from './views/login.js';
import { serversView, serverDetailView } from './views/servers.js';
import { eventsView } from './views/events.js';
import { overviewView } from './views/overview.js';
import { databaseView } from './views/database.js';
import { operationsView } from './views/operations.js';
import { alertsView } from './views/alerts.js';
import { settingsView } from './views/settings.js';
import { usersView } from './views/users.js';
import { changePasswordDialog, choosePasswordView } from './views/account.js';

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const liveIndicator = document.getElementById('live-indicator');

// mustChangePassword: someone else chose this user's password; nothing else is shown until they pick their own.
const state = { user: null, mustChangePassword: false, stream: null, current: null };

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
    [/^\/users$/, () => usersView({ currentUser: () => state.user })],
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
    if (state.mustChangePassword) {
        topbar.hidden = true;
        state.current = choosePasswordView({ username: state.user, onDone: onLogin, onSignOut: signOut });
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

// --- live updates over SSE, and the connection badge ------------------------
// Online while the stream delivers (the server sends a ping every 15 s);
// Reconnecting while the last contact was less than a minute ago; Offline after that.
const liveText = liveIndicator.querySelector('.live-text');
const LIVE_LABELS = { connecting: 'Connecting', online: 'Online', reconnecting: 'Reconnecting', offline: 'Offline' };
const OFFLINE_AFTER_MS = 60_000;
const SILENT_AFTER_MS = 40_000; // no ping for this long: the connection is gone, even if the browser has not noticed
const RETRY_MS = 5000;
const live = { status: null, lastContact: 0, offlineTimer: 0, silentTimer: 0, retryTimer: 0 };

function setLiveStatus(status) {
    if (live.status === status) return;
    const was = live.status;
    live.status = status;
    liveIndicator.dataset.state = status;
    liveText.textContent = LIVE_LABELS[status];
    // Only lasting changes are announced; a blip of a few seconds is not.
    if (status === 'offline') toast('Lost the connection to Mostly-On. This page is not being updated; it keeps trying to reconnect.', 'err');
    if (status === 'online' && was === 'offline') toast('Connected to Mostly-On again. Reload the page if something looks out of date.', 'ok');
    // The badge changed width: check that the navigation still fits on one row.
    lastHeaderWidth = 0;
    layoutNav();
}

function heardFromServer() {
    live.lastContact = Date.now();
    clearTimeout(live.offlineTimer);
    clearTimeout(live.silentTimer);
    live.silentTimer = setTimeout(() => {
        lostContact();
        restartStream(0);
    }, SILENT_AFTER_MS);
    setLiveStatus('online');
}

function lostContact() {
    clearTimeout(live.silentTimer);
    if (live.status === 'offline') return;
    const since = Date.now() - live.lastContact;
    if (since >= OFFLINE_AFTER_MS) {
        setLiveStatus('offline');
        return;
    }
    if (live.status !== 'connecting') setLiveStatus('reconnecting');
    clearTimeout(live.offlineTimer);
    live.offlineTimer = setTimeout(() => setLiveStatus('offline'), OFFLINE_AFTER_MS - since);
}

/** A new stream after `delay`, once the session is confirmed: an ended session signs out instead of retrying. */
function restartStream(delay) {
    state.stream?.close();
    state.stream = null;
    clearTimeout(live.retryTimer);
    live.retryTimer = setTimeout(async () => {
        if (!state.user) return;
        let me;
        try {
            me = await get('/api/auth/me');
        } catch {
            restartStream(RETRY_MS);
            return;
        }
        if (!me.user) sessionEnded();
        else if (state.user) connectStream();
    }, delay);
}

function connectStream() {
    if (state.stream) return;
    clearTimeout(live.retryTimer);
    if (!live.status) {
        live.lastContact = Date.now();
        setLiveStatus('connecting');
        live.offlineTimer = setTimeout(() => setLiveStatus('offline'), OFFLINE_AFTER_MS);
    }
    const es = new EventSource('/api/stream');
    state.stream = es;
    es.onopen = heardFromServer;
    es.addEventListener('ping', heardFromServer);
    es.onerror = () => {
        if (state.stream !== es) return;
        lostContact();
        // The browser retries by itself, except after an error response (a proxy's
        // 502 while Mostly-On restarts, or a 401): then the stream is CLOSED for good.
        if (es.readyState === EventSource.CLOSED) restartStream(RETRY_MS);
    };
    const dispatch = (e) => {
        heardFromServer();
        let evt;
        try {
            evt = JSON.parse(e.data);
        } catch {
            return;
        }
        state.current?.onEvent?.(evt);
    };
    for (const type of ['event', 'server.health', 'database.changed', 'replica.changed', 'backup.started', 'backup.finished', 'restore.finished', 'operation.updated', 'alert.changed', 'backup.failed', 'discovery.changed', 'foreign.detected', 'users.changed']) {
        es.addEventListener(type, dispatch);
    }
}

function disconnectStream() {
    state.stream?.close();
    state.stream = null;
    clearTimeout(live.offlineTimer);
    clearTimeout(live.silentTimer);
    clearTimeout(live.retryTimer);
    live.status = null; // signed out: the top bar is hidden, and the next sign-in starts at Connecting
}

// The account menu in the top bar: who is signed in, Change password, Sign out.
const account = document.getElementById('account');
function renderAccount() {
    const label = [h('span.visually-hidden', 'Signed in as '), state.user];
    account.replaceChildren(
        ...menuButton(
            label,
            [
                { label: 'Change password', onSelect: () => changePasswordDialog(state.user) },
                { label: 'Sign out', onSelect: signOut },
            ],
            { className: '.link' },
        ),
    );
}

function onLogin(me) {
    const wasUser = state.user;
    state.user = me.user;
    state.mustChangePassword = !!me.mustChangePassword;
    setCsrf(me.csrfToken);
    if (state.user !== wasUser) renderAccount();
    if (!state.mustChangePassword) connectStream();
    render();
}

async function signOut() {
    try {
        await post('/api/auth/logout');
    } catch {
        /* session may already be gone */
    }
    state.user = null;
    state.mustChangePassword = false;
    setCsrf(null);
    disconnectStream();
    render();
}

/** The server no longer knows this session (expired, signed out elsewhere, user disabled). */
function sessionEnded() {
    if (!state.user) return;
    state.user = null;
    state.mustChangePassword = false;
    disconnectStream();
    toast('Your session has ended. Please sign in again.');
    render();
}
window.addEventListener('auth-required', sessionEnded);

document.getElementById('skip-to-content').addEventListener('click', () => app.focus());

window.addEventListener('hashchange', () => {
    navigated = true;
    render();
});

try {
    const me = await get('/api/auth/me');
    if (me.user) onLogin(me);
    else render();
} catch {
    render();
}
