// Settings, events and the SSE stream.
import { HttpError, actorOf } from '../router.js';
import { openStream } from '../sse.js';
import * as settings from '../../store/repos/settings.js';
import * as events from '../../store/repos/events.js';
import * as sessions from '../../store/repos/sessions.js';
import { validateSchedule } from '../../engine/schedule-math.js';
import * as databases from '../../store/repos/databases.js';
import * as schedules from '../../store/repos/schedules.js';
import { DEFAULT_SCHEDULE_KEYS } from '../../store/repos/schedules.js';
import { applyDefaultSchedules } from '../../engine/scheduler.js';
import { checkAllRetention, globalRetention } from '../../engine/retention-rules.js';

/**
 * A default schedule as stored. Only the DIFF default has an on/off switch
 * (FULL and LOG backups are never optional); when the request leaves it out,
 * the stored value stays (a value stored before the switch existed is on).
 */
export function defaultScheduleValue(key, v, previous) {
    if (v === null || typeof v !== 'object') throw new Error(`Setting ${key} must be a schedule`);
    const s = validateSchedule({ ...v, enabled: true });
    const out = { kind: s.kind, interval_minutes: s.interval_minutes, at_time: s.at_time, weekday: s.weekday };
    if (key === 'schedule.default_diff') out.enabled = typeof v.enabled === 'boolean' ? v.enabled : previous?.enabled !== false;
    return out;
}

export function miscRoutes(router, { cfg }) {
    // Facts about this controller the dashboard shows (for example as placeholders).
    router.get('/api/info', async () => ({
        backupRoot: cfg.backupRoot,
        maxParallel: settings.get('servers.max_parallel'),
        // What a database gets when it starts being managed (the Manage dialog says so).
        defaultSchedules: Object.fromEntries(DEFAULT_SCHEDULE_KEYS.map(([type, key]) => [type, settings.get(key)])),
        // How many databases follow each default schedule, and how many have their own (Settings says so).
        defaultScheduleUse: schedules.defaultUse(),
    }));

    router.get('/api/settings', async () => settings.all());

    router.put('/api/settings', async (ctx) => {
        const body = ctx.body || {};
        const changed = [];
        try {
            // Validate everything before storing anything, so a bad value saves nothing.
            const values = Object.entries(body).map(([k, v]) => {
                if (k.startsWith('schedule.default_')) return [k, defaultScheduleValue(k, v, settings.get(k))];
                return [k, v];
            });
            for (const [k, v] of values) settings.check(k, v);
            // FULL backups must outlive the DIFF and LOG backups that build on them, here and for every database.
            if (values.some(([k]) => k.startsWith('retention.') && k.endsWith('_days'))) {
                const merged = { ...settings.all(), ...Object.fromEntries(values) };
                const problem = checkAllRetention(globalRetention(merged), databases.list());
                if (problem) throw new Error(problem);
            }
            for (const [k, v] of values) {
                settings.set(k, v);
                changed.push(k);
            }
        } catch (err) {
            throw new HttpError(400, err.message);
        }
        if (changed.length) events.add('info', 'settings', `Settings changed: ${changed.join(', ')}`, { data: body, actor: actorOf(ctx) });
        // Databases that follow a default schedule take the new one.
        const types = DEFAULT_SCHEDULE_KEYS.filter(([, key]) => changed.includes(key)).map(([type]) => type);
        if (types.length) applyDefaultSchedules(types, { actor: actorOf(ctx) });
        return settings.all();
    });

    router.get('/api/events', async (ctx) =>
        events.list({
            databaseId: ctx.query.database_id ? Number(ctx.query.database_id) : undefined,
            serverId: ctx.query.server_id ? Number(ctx.query.server_id) : undefined,
            operationId: ctx.query.operation_id ? Number(ctx.query.operation_id) : undefined,
            peopleOnly: ctx.query.people_only === '1',
            beforeId: ctx.query.before_id ? Number(ctx.query.before_id) : undefined,
            limit: ctx.query.limit ? Number(ctx.query.limit) : 200,
        }),
    );

    router.get('/api/stream', async (ctx) => {
        ctx.handled = true;
        const token = ctx.sessionToken;
        openStream(ctx.req, ctx.res, { stillValid: () => !!sessions.lookup(token) });
    });
}
