// Structured JSON-lines logger to stdout. One line per record:
// {"ts":"...","level":"info","msg":"...", ...fields}
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level) {
    threshold = LEVELS[level] ?? LEVELS.info;
}

function serializeError(err) {
    if (!(err instanceof Error)) return err;
    const out = { name: err.name, message: err.message };
    if (err.code) out.code = err.code;
    if (err.number) out.number = err.number;
    if (err.stack && threshold <= LEVELS.debug) out.stack = err.stack;
    return out;
}

function write(level, base, msg, fields) {
    if (LEVELS[level] < threshold) return;
    const rec = { ts: new Date().toISOString(), level, msg, ...base };
    if (fields) {
        for (const [k, v] of Object.entries(fields)) rec[k] = v instanceof Error ? serializeError(v) : v;
    }
    let line;
    try {
        line = JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
        line = JSON.stringify({ ts: rec.ts, level, msg, note: 'unserializable fields' });
    }
    process.stdout.write(line + '\n');
}

function make(base) {
    return {
        debug: (msg, f) => write('debug', base, msg, f),
        info: (msg, f) => write('info', base, msg, f),
        warn: (msg, f) => write('warn', base, msg, f),
        error: (msg, f) => write('error', base, msg, f),
        child: (more) => make({ ...base, ...more }),
    };
}

export const log = make({});
