// Server-Sent Events: forwards bus events to authenticated browser sessions.
import { subscribe } from '../bus.js';

const clients = new Set();
const HEARTBEAT_MS = 15_000;

export function clientCount() {
    return clients.size;
}

/** @param {{stillValid?:()=>boolean}} [opts] stream is closed when the session ends */
export function openStream(req, res, opts = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (evt) => {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    };
    const unsubscribe = subscribe(send);
    // A named event, not a comment: the page sees it, and treats a stream that
    // stays silent well past this interval as dropped (public/app.js).
    const heartbeat = setInterval(() => {
        if (opts.stillValid && !opts.stillValid()) {
            res.end();
            return;
        }
        res.write('event: ping\ndata: {}\n\n');
    }, HEARTBEAT_MS);
    const client = { res, close: () => res.end() };
    clients.add(client);

    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        clients.delete(client);
    });
}

export function closeAllStreams() {
    for (const c of clients) c.close();
    clients.clear();
}
