import { HttpError, idParam } from '../router.js';
import * as ops from '../../store/repos/operations.js';
import * as databases from '../../store/repos/databases.js';

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'resolved'];

function withNames(op) {
    const db = op.database_id ? databases.get(op.database_id) : null;
    return { ...op, database_name: db?.name ?? null };
}

export function operationRoutes(router) {
    router.get('/api/operations', async (ctx) => {
        const status = ctx.query.status ? ctx.query.status.split(',').filter((s) => STATUSES.includes(s)) : undefined;
        return ops
            .list({
                status,
                type: ctx.query.type || undefined,
                databaseId: ctx.query.database_id ? Number(ctx.query.database_id) : undefined,
                includeRoutine: ctx.query.include_routine === '1',
                beforeId: ctx.query.before_id ? Number(ctx.query.before_id) : undefined,
                limit: Number(ctx.query.limit) || 100,
            })
            .map(withNames);
    });

    router.get('/api/operations/:id', async (ctx) => {
        const op = ops.get(idParam(ctx.params.id));
        if (!op) throw new HttpError(404, 'Operation not found');
        return withNames(op);
    });
}
