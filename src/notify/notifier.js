// Notification channels. A channel is
//   { name, configured: boolean, send({ title, message, priority, url, urlTitle }) }
// where send() resolves when the message was accepted and throws otherwise.
// Pushover is the only channel today; others register the same way.

const channels = [];

export function register(channel) {
    const i = channels.findIndex((c) => c.name === channel.name);
    if (i >= 0) channels.splice(i, 1, channel);
    else channels.push(channel);
}

export function status() {
    return channels.map((c) => ({ name: c.name, configured: c.configured }));
}

export function anyConfigured() {
    return channels.some((c) => c.configured);
}

/**
 * Sends to every configured channel. Resolves with the channels that took the
 * message; throws if none did (or none is configured).
 */
export async function sendAll(msg) {
    const targets = channels.filter((c) => c.configured);
    if (!targets.length) throw Object.assign(new Error('No notification channel is configured'), { status: 409, expose: true });
    const results = await Promise.allSettled(targets.map((c) => c.send(msg)));
    const sent = targets.filter((_, i) => results[i].status === 'fulfilled').map((c) => c.name);
    const errors = targets.flatMap((c, i) => (results[i].status === 'rejected' ? [`${c.name}: ${results[i].reason?.message || results[i].reason}`] : []));
    if (!sent.length) throw Object.assign(new Error(errors.join('; ')), { status: 502, expose: true });
    return { sent, errors };
}

/** Test helper. */
export function _reset() {
    channels.length = 0;
}
