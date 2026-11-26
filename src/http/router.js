// Minimal method + path router with :params.

export class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

export class Router {
    constructor() {
        this.routes = [];
    }

    /**
     * @param {string} method
     * @param {string} pattern e.g. '/api/servers/:id'
     * @param {(ctx:object)=>any} handler
     * @param {{auth?:boolean, csrf?:boolean, beforePasswordChange?:boolean}} [opts] auth and csrf default to true;
     *   beforePasswordChange: allowed for a user who must change their password first (default false)
     */
    add(method, pattern, handler, opts = {}) {
        const keys = [];
        const re = new RegExp(
            '^' +
                pattern.replace(/\/:([A-Za-z_]+)/g, (_m, k) => {
                    keys.push(k);
                    return '/([^/]+)';
                }) +
                '/?$',
        );
        this.routes.push({ method, re, keys, handler, auth: opts.auth !== false, csrf: opts.csrf !== false, beforePasswordChange: opts.beforePasswordChange === true });
        return this;
    }

    get(p, h, o) {
        return this.add('GET', p, h, o);
    }
    post(p, h, o) {
        return this.add('POST', p, h, o);
    }
    put(p, h, o) {
        return this.add('PUT', p, h, o);
    }
    delete(p, h, o) {
        return this.add('DELETE', p, h, o);
    }

    /** Returns { route, params } or { allowed: [...] } when only the method mismatches. */
    match(method, pathname) {
        const allowed = [];
        for (const r of this.routes) {
            const m = r.re.exec(pathname);
            if (!m) continue;
            if (r.method !== method) {
                allowed.push(r.method);
                continue;
            }
            const params = {};
            r.keys.forEach((k, i) => {
                params[k] = decodeURIComponent(m[i + 1]);
            });
            return { route: r, params };
        }
        return { route: null, allowed };
    }
}

/** Parses a positive integer route param or throws 400. */
export function idParam(v, name = 'id') {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${name}`);
    return n;
}

/** The user behind a request, for the audit trail (null when not logged in). */
export function actorOf(ctx) {
    return ctx.session?.username ?? null;
}
