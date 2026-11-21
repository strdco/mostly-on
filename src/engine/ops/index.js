// Resume and resolve for multi-step operations that failed or were
// interrupted. Nothing is ever resumed automatically (D7): a user decides.
import * as opsRepo from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import { publish } from '../../bus.js';
import { nowIso } from '../../store/db.js';
import { resumeSeed } from './seed.js';
import { resumeFailover } from './failover.js';
import { resumeSwitchoverAll } from './switchover-all.js';
import { resumePointInTime } from './pitr.js';

const RESUMERS = {
    seed: resumeSeed,
    reseed: resumeSeed,
    planned_failover: resumeFailover,
    forced_failover: resumeFailover,
    switchover_all: resumeSwitchoverAll,
    pitr_copy: resumePointInTime,
    pitr_rollback: resumePointInTime,
};
const CLOSABLE = ['failed', 'interrupted'];

function fail(status, message) {
    return Object.assign(new Error(message), { status, expose: true });
}

export function canResume(op) {
    return CLOSABLE.includes(op.status) && !!RESUMERS[op.type];
}

export function canResolve(op) {
    return CLOSABLE.includes(op.status) && op.type !== 'backup';
}

/** Re-runs the operation from its first unfinished step (each step checks before it runs). */
export async function resumeOperation(id) {
    const op = opsRepo.get(id);
    if (!op) throw fail(404, 'Operation not found');
    if (!canResume(op)) throw fail(409, `Operation #${id} (${op.type}, ${op.status}) cannot be resumed`);
    if (op.parent_id && ['running', 'queued'].includes(opsRepo.get(op.parent_id)?.status)) {
        throw fail(409, `Operation #${id} is part of the running operation #${op.parent_id}`);
    }
    const { operation } = await RESUMERS[op.type](op);
    return operation;
}

/** The user has dealt with a failed or interrupted operation by hand. */
export function resolveOperation(id, note = '') {
    const op = opsRepo.get(id);
    if (!op) throw fail(404, 'Operation not found');
    if (!canResolve(op)) throw fail(409, `Operation #${id} (${op.type}, ${op.status}) cannot be marked resolved`);
    const saved = opsRepo.save(id, { status: 'resolved', finished_at: nowIso() });
    events.add('warn', op.type, `Operation #${id} (${op.type}) marked as resolved manually${note ? `: ${note}` : ''}`, {
        databaseId: op.database_id,
        serverId: op.server_id,
        operationId: id,
    });
    publish('operation.updated', { id, type: op.type, status: 'resolved', databaseId: op.database_id, steps: saved.steps });
    return saved;
}
