// Session cookie, CSRF and origin checks, and the login rate limiter.
import * as sessions from '../store/repos/sessions.js';
import { safeEqual } from '../crypto.js';

export function cookieName(cfg) {
    // The __Host- prefix pins the cookie to this host, path / and HTTPS.
    return cfg.cookieSecure ? '__Host-cl_sid' : 'cl_sid';
}

export function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && !(k in out)) {
            try {
                out[k] = decodeURIComponent(v);
            } catch {
                out[k] = v;
            }
        }
    }
    return out;
}

export function sessionCookie(cfg, token, expiresAt) {
    const attrs = [`${cookieName(cfg)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Expires=${expiresAt.toUTCString()}`];
    if (cfg.cookieSecure) attrs.push('Secure');
    return attrs.join('; ');
}

export function clearCookie(cfg) {
    const attrs = [`${cookieName(cfg)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (cfg.cookieSecure) attrs.push('Secure');
    return attrs.join('; ');
}

export function sessionFromRequest(cfg, req) {
    const token = parseCookies(req.headers.cookie)[cookieName(cfg)];
    return token ? { token, session: sessions.lookup(token) } : { token: null, session: null };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (m) => SAFE_METHODS.has(m);

/**
 * Rejects cross-origin state-changing requests. Browsers always send Origin on
 * POST/PUT/DELETE; non-browser clients (curl) may omit it and then rely on the
 * CSRF token alone.
 */
export function originAllowed(cfg, req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    if (origin === cfg.publicOrigin) return true;
    const host = req.headers.host;
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

export function csrfValid(session, req) {
    const t = req.headers['x-csrf-token'];
    return !!session && typeof t === 'string' && safeEqual(t, session.csrfToken);
}

/** Fixed-window limiter for failed logins, per client address. */
export class LoginLimiter {
    constructor({ maxFailures = 10, windowMs = 15 * 60_000 } = {}) {
        this.max = maxFailures;
        this.windowMs = windowMs;
        this.map = new Map();
    }
    blocked(key) {
        const e = this.map.get(key);
        if (!e) return false;
        if (Date.now() - e.start > this.windowMs) {
            this.map.delete(key);
            return false;
        }
        return e.count >= this.max;
    }
    fail(key) {
        const now = Date.now();
        const e = this.map.get(key);
        if (!e || now - e.start > this.windowMs) this.map.set(key, { start: now, count: 1 });
        else e.count += 1;
        if (this.map.size > 10_000) this.map.clear(); // crude memory bound
    }
    reset(key) {
        this.map.delete(key);
    }
}
