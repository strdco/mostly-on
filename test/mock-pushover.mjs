// A stand-in for the Pushover API, for tests. No dependencies.
//
//   POST /1/messages.json   records the message; answers like Pushover
//   GET  /messages          everything recorded, oldest first
//   DELETE /messages        forget everything
//   POST /fail?on=1|0       make POST /1/messages.json fail with HTTP 500 (or stop failing)
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.MOCK_PUSHOVER_PORT || 9911);
const messages = [];
let failing = false;

const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
        if (req.method === 'POST' && url.pathname === '/1/messages.json') {
            const fields = Object.fromEntries(new URLSearchParams(raw));
            if (failing) return json(res, 500, { status: 0, errors: ['mock is failing on purpose'] });
            if (!fields.token || !fields.user || !fields.message) return json(res, 400, { status: 0, errors: ['token, user and message are required'] });
            const request = randomUUID();
            messages.push({ receivedAt: new Date().toISOString(), request, title: fields.title, message: fields.message, priority: Number(fields.priority ?? 0), url: fields.url });
            console.log(`[mock-pushover] ${fields.title} | ${fields.message.replace(/\n/g, ' / ')}`);
            return json(res, 200, { status: 1, request });
        }
        if (req.method === 'GET' && url.pathname === '/messages') return json(res, 200, messages);
        if (req.method === 'DELETE' && url.pathname === '/messages') {
            messages.length = 0;
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/fail') {
            failing = url.searchParams.get('on') === '1';
            return json(res, 200, { failing });
        }
        json(res, 404, { error: 'not found' });
    });
}).listen(port, () => console.log(`[mock-pushover] listening on ${port}`));
