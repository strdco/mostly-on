// Alerts and notification delivery.
import { HttpError } from '../router.js';
import * as alertsRepo from '../../store/repos/alerts.js';
import { deliveryStatus, sendTest } from '../../notify/alerts.js';

export function alertRoutes(router) {
    // ?status=active|resolved (default: both), ?limit=
    router.get('/api/alerts', async (ctx) => {
        const status = ctx.query.status || null;
        if (status && !['active', 'resolved'].includes(status)) throw new HttpError(400, 'status must be active or resolved');
        return alertsRepo.list({ status, limit: Number(ctx.query.limit) || 200 });
    });

    router.get('/api/notifications', async () => deliveryStatus());

    router.post('/api/notifications/test', async () => {
        const r = await sendTest();
        return { ok: true, sent: r.sent, errors: r.errors };
    });
}
