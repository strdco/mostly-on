// Key/value settings with typed defaults. Values are JSON.
import { getDb } from '../db.js';

export const DEFAULTS = Object.freeze({
    'health.interval_seconds': 30,
    'discovery.interval_seconds': 300,
    'restore.poll_seconds': 30,
    'servers.max_parallel': 2, // backups and restores at a time per SQL Server (a server can have its own)
    'alerts.interval_seconds': 30,
    'alerts.lag_threshold_minutes': 30,
    'alerts.reminder_hours': 4, // 0 = no reminders
    'alerts.debounce_seconds': 60, // a condition must hold (or be gone) this long before it alerts (or resolves)
    'auto_manage.drop_after_minutes': 30, // servers that manage databases automatically: how long a database must be gone
    'retention.full_days': 28,
    'retention.diff_days': 14,
    'retention.log_days': 7,
    'retention.interval_minutes': 60,
    'retention.enabled': true,
    'msdb_history.purge_enabled': false,
    'msdb_history.keep_days': 90,
    'schedule.default_full': { kind: 'weekly', weekday: 0, at_time: '01:00' },
    'schedule.default_diff': { kind: 'daily', at_time: '01:30', enabled: false }, // DIFF backups are optional; only this default can be off
    'schedule.default_log': { kind: 'interval', interval_minutes: 5 },
});

const VALIDATORS = {
    number: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    boolean: (v) => typeof v === 'boolean',
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// Lower bounds for numbers where 0 would make a loop spin or an alert meaningless.
const MINIMUMS = {
    'health.interval_seconds': 5,
    'discovery.interval_seconds': 30,
    'restore.poll_seconds': 5,
    'alerts.interval_seconds': 5,
    'alerts.lag_threshold_minutes': 1,
    'retention.interval_minutes': 1,
    'retention.full_days': 1,
    'retention.diff_days': 1,
    'retention.log_days': 1,
    'msdb_history.keep_days': 1,
    'servers.max_parallel': 1,
    'auto_manage.drop_after_minutes': 5,
};

// Upper bounds, and settings that must be whole numbers.
export const MAXIMUMS = {
    'servers.max_parallel': 10,
};
const WHOLE = new Set(['servers.max_parallel']);

export function get(key) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
    const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : DEFAULTS[key];
}

export function all() {
    const stored = Object.fromEntries(
        getDb()
            .prepare('SELECT key, value FROM settings')
            .all()
            .map((r) => [r.key, JSON.parse(r.value)]),
    );
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = k in stored ? stored[k] : DEFAULTS[k];
    return out;
}

/** Throws if `value` is not acceptable for `key`. */
export function check(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
    const kind = typeof DEFAULTS[key];
    if (!VALIDATORS[kind](value)) throw new Error(`Setting ${key} must be a ${kind}`);
    if (key in MINIMUMS && value < MINIMUMS[key]) throw new Error(`Setting ${key} must be at least ${MINIMUMS[key]}`);
    if (key in MAXIMUMS && value > MAXIMUMS[key]) throw new Error(`Setting ${key} must be at most ${MAXIMUMS[key]}`);
    if (WHOLE.has(key) && !Number.isInteger(value)) throw new Error(`Setting ${key} must be a whole number`);
}

export function set(key, value) {
    check(key, value);
    getDb()
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify(value));
}
