// Pure schedule arithmetic. Times of day are in the controller's local time
// zone (TZ environment variable); the result is an absolute Date.

/**
 * Next run strictly after `from`.
 * @param {{kind:'interval'|'daily'|'weekly', interval_minutes?:number, at_time?:string, weekday?:number}} s
 * @param {Date} from
 */
export function nextRun(s, from) {
    const t = from.getTime();
    if (s.kind === 'interval') {
        const ms = s.interval_minutes * 60_000;
        // Aligned to a fixed grid so a 5-minute schedule runs at :00, :05, ...
        return new Date(Math.floor(t / ms) * ms + ms);
    }
    const [hh, mm] = s.at_time.split(':').map(Number);
    const d = new Date(from);
    d.setHours(hh, mm, 0, 0);
    if (s.kind === 'daily') {
        if (d.getTime() <= t) d.setDate(d.getDate() + 1);
        d.setHours(hh, mm, 0, 0); // re-apply after a DST shift
        return d;
    }
    if (s.kind === 'weekly') {
        let add = (s.weekday - d.getDay() + 7) % 7;
        if (add === 0 && d.getTime() <= t) add = 7;
        d.setDate(d.getDate() + add);
        d.setHours(hh, mm, 0, 0);
        return d;
    }
    throw new Error(`Unknown schedule kind ${s.kind}`);
}

/** Validates schedule input from the API. Returns a normalized object or throws. */
export function validateSchedule(input) {
    const err = (m) => Object.assign(new Error(m), { status: 400 });
    const out = { enabled: input.enabled === undefined ? 1 : input.enabled ? 1 : 0, kind: input.kind };
    if (!['interval', 'daily', 'weekly'].includes(out.kind)) throw err('kind must be interval, daily or weekly');
    if (out.kind === 'interval') {
        const n = Number(input.interval_minutes);
        if (!Number.isInteger(n) || n < 1 || n > 10080) throw err('interval_minutes must be 1-10080');
        Object.assign(out, { interval_minutes: n, at_time: null, weekday: null });
    } else {
        if (typeof input.at_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.at_time)) throw err('at_time must be HH:MM');
        out.at_time = input.at_time;
        out.interval_minutes = null;
        if (out.kind === 'weekly') {
            const w = Number(input.weekday);
            if (!Number.isInteger(w) || w < 0 || w > 6) throw err('weekday must be 0 (Sunday) to 6');
            out.weekday = w;
        } else out.weekday = null;
    }
    return out;
}
