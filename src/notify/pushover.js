// Pushover channel (https://pushover.net/api). The API URL can be overridden
// (PUSHOVER_API_URL) so tests can point it at a mock.

const LIMITS = { title: 250, message: 1024, url: 512, url_title: 100 };

function clip(s, n) {
    s = String(s ?? '');
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function createPushover({ appToken, userKey, apiUrl }) {
    return {
        name: 'pushover',
        configured: !!(appToken && userKey),
        async send({ title, message, priority = 0, url, urlTitle }) {
            const form = new URLSearchParams({ token: appToken, user: userKey, title: clip(title, LIMITS.title), message: clip(message, LIMITS.message), priority: String(priority) });
            if (url) form.set('url', clip(url, LIMITS.url));
            if (url && urlTitle) form.set('url_title', clip(urlTitle, LIMITS.url_title));
            let res;
            try {
                res = await fetch(apiUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
            } catch (err) {
                throw new Error(`Pushover is unreachable: ${err.cause?.message || err.message}`);
            }
            let body = null;
            try {
                body = await res.json();
            } catch {
                /* not JSON */
            }
            if (!res.ok || body?.status !== 1) {
                const detail = body?.errors?.join('; ') || `HTTP ${res.status}`;
                throw new Error(`Pushover refused the message: ${detail}`);
            }
            return body.request;
        },
    };
}
