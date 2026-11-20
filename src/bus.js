// In-process event bus. Used for SSE fan-out and for nudging loops
// (e.g. "a log backup finished" wakes the restore loops).
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Publish an event. `type` is a dotted string such as "server.health". */
export function publish(type, payload = {}) {
    emitter.emit('event', { type, payload, ts: new Date().toISOString() });
}

/** Subscribe to all events. Returns an unsubscribe function. */
export function subscribe(fn) {
    emitter.on('event', fn);
    return () => emitter.off('event', fn);
}
