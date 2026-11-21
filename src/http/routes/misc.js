// Settings, events and the SSE stream.
import { HttpError } from '../router.js';
import { openStream } from '../sse.js';
import * as settings from '../../store/repos/settings.js';
import * as events from '../../store/repos/events.js';
import * as sessions from '../../store/repos/sessions.js';
import { validateSchedule } from '../../engine/schedule-math.js';

export function miscRoutes(router, { cfg }) {
    // Facts about this controller the dashboard shows (for example as placeholders).
    router.get('/api/info', async () => ({ backupRoot: cfg.backupRoot }));

    router.get('/api/settings', async () => settings.all());

    router.put('/api/settings', async (ctx) => {
        const body = ctx.body || {};
        const changed = [];
        try {
            // Validate everything before storing anything, so a bad value saves nothing.
            const values = Object.entries(body).map(([k, v]) => {
                if (k.startsWith('schedule.default_')) {
                    if (v === null || typeof v !== 'object') throw new Error(`Setting ${k} must be a schedule`);
                    const s = validateSchedule({ ...v, enabled: true });
                    return [k, { kind: s.kind, interval_minutes: s.interval_minutes, at_time: s.at_time, weekday: s.weekday }];
                }
                return [k, v];
            });
            for (const [k, v] of values) settings.check(k, v);
            for (const [k, v] of values) {
                settings.set(k, v);
                changed.push(k);
            }
        } catch (err) {
            throw new HttpError(400, err.message);
        }
        if (changed.length) events.add('info', 'settings', `Settings changed: ${changed.join(', ')}`, { data: body });
        return settings.all();
    });

    router.get('/api/events', async (ctx) =>
        events.list({
            databaseId: ctx.query.database_id ? Number(ctx.query.database_id) : undefined,
            serverId: ctx.query.server_id ? Number(ctx.query.server_id) : undefined,
            operationId: ctx.query.operation_id ? Number(ctx.query.operation_id) : undefined,
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
