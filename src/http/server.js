// HTTP server: security headers, auth/CSRF gate for /api, JSON in/out, static files.
import http from 'node:http';
import { Router, HttpError } from './router.js';
import { serveStatic } from './static.js';
import { sessionFromRequest, isSafeMethod, originAllowed, csrfValid } from './auth.js';
import { log } from '../log.js';

const MAX_BODY = 1024 * 1024;

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, 'Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            const ct = req.headers['content-type'] || '';
            if (!ct.startsWith('application/json')) return reject(new HttpError(415, 'Expected application/json'));
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new HttpError(400, 'Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * @param {object} cfg config
 * @param {(router: Router) => void} registerRoutes
 */
export function createHttpServer(cfg, registerRoutes) {
    const router = new Router();
    registerRoutes(router);

    const server = http.createServer(async (req, res) => {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            res.writeHead(400).end();
            return;
        }
        const pathname = url.pathname;

        if (pathname === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
            return;
        }
        if (!pathname.startsWith('/api/')) {
            serveStatic(req, res, pathname);
            return;
        }

        const started = Date.now();
        try {
            const { route, params, allowed } = router.match(req.method, pathname);
            if (!route) {
                if (allowed?.length) throw new HttpError(405, 'Method not allowed');
                throw new HttpError(404, 'Not found');
            }

            const { token, session } = sessionFromRequest(cfg, req);
            if (route.auth && !session) throw new HttpError(401, 'Not logged in');
            if (!isSafeMethod(req.method)) {
                if (!originAllowed(cfg, req)) throw new HttpError(403, 'Cross-origin request rejected');
                if (route.csrf && !csrfValid(session, req)) throw new HttpError(403, 'Missing or invalid CSRF token');
            }

            const body = isSafeMethod(req.method) ? {} : await readBody(req);
            const ctx = {
                req,
                res,
                url,
                params,
                query: Object.fromEntries(url.searchParams),
                body,
                session,
                sessionToken: token,
                ip: req.socket.remoteAddress,
                headers: {},
                handled: false,
            };
            const result = await route.handler(ctx);
            if (!ctx.handled) sendJson(res, ctx.status || 200, result ?? { ok: true }, ctx.headers);
            if (route.method !== 'GET') {
                log.debug('API request', { method: req.method, path: pathname, ms: Date.now() - started });
            }
        } catch (err) {
            const status = err.status && Number.isInteger(err.status) ? err.status : 500;
            if (status >= 500) log.error('API request failed', { method: req.method, path: pathname, err });
            if (!res.headersSent) {
                sendJson(res, status, { error: status >= 500 && !err.expose ? `Internal error: ${err.message}` : err.message, details: err.details });
            } else {
                res.end();
            }
        }
    });
    server.requestTimeout = 0; // SSE streams are long-lived
    server.headersTimeout = 30_000;
    return server;
}
