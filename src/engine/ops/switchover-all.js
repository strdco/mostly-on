// "Switch over all databases on server X to server Y": one planned failover
// per database, run one after the other. The batch stops at the first
// failure; resuming it resumes that failover and then carries on.
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as opsRepo from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import * as health from '../health.js';
import { createOperation, runOperation } from '../operations.js';
import { startPlannedFailover, resumeFailover } from './failover.js';
import { publish } from '../../bus.js';

function fail(status, message, details) {
    return Object.assign(new Error(message), { status, expose: true, details });
}

/** Databases whose primary is `fromId`, and whether each can move to `toId`. */
export function switchoverPlan(fromId, toId) {
    const from = serversRepo.get(fromId);
    const to = serversRepo.get(toId);
    if (!from || !to) throw fail(404, 'Server not found');
    if (from.id === to.id) throw fail(400, 'Pick two different servers');
    const items = databases
        .replicasOnServer(from.id)
        .filter((r) => r.role === 'primary')
        .map((r) => {
            const target = databases.replica(r.database_id, to.id);
            let problem = null;
            if (!target || target.role !== 'secondary') problem = `${to.name} is not a secondary of ${r.database_name}`;
            else if (target.chain_state !== 'ok') problem = `shipping to ${to.name} is ${target.chain_state}`;
            return { databaseId: r.database_id, name: r.database_name, problem };
        });
    return { from, to, items };
}

function childSteps(plan, toId) {
    return plan.map(({ databaseId, name }) => ({
        name: `db_${databaseId}`,
        label: `Planned failover of ${name}`,
        guidance: `The failover of ${name} stopped; its own operation shows the step and what to do. Resume this batch to resume that failover and continue with the rest.`,
        check: () => (databases.primaryOf(databaseId)?.server_id === toId ? `${name} is already on the target` : false),
        run: async (ctx) => {
            const children = ctx.state.children || {};
            const prev = children[databaseId] ? opsRepo.get(children[databaseId]) : null;
            let started;
            if (prev && ['failed', 'interrupted'].includes(prev.status)) {
                started = await resumeFailover(prev);
            } else {
                const db = databases.get(databaseId);
                started = await startPlannedFailover(databaseId, { serverId: toId, confirm: db.name, parentId: ctx.op.id });
                ctx.save({ children: { ...children, [databaseId]: started.operation.id } });
            }
            ctx.progress(`Running operation #${started.operation.id}`);
            const op = await started.done;
            if (op.status !== 'succeeded') throw new Error(`Operation #${op.id} ${op.status}: ${op.error}`);
            return `Operation #${op.id} succeeded`;
        },
    }));
}

export async function startSwitchoverAll({ fromServerId, toServerId, confirm }) {
    const { from, to, items } = switchoverPlan(fromServerId, toServerId);
    if (confirm !== from.name) throw fail(400, `Type ${from.name} to confirm`);
    if (!items.length) throw fail(409, `${from.name} is not the primary of any managed database`);
    const blocked = items.filter((i) => i.problem);
    if (blocked.length) throw fail(409, `Cannot switch over: ${blocked.map((b) => `${b.name}: ${b.problem}`).join('; ')}`, { blocked });
    if (!health.getHealth(from.id)?.ok) throw fail(409, `${from.name} is unreachable; switch over needs it (use forced failovers per database)`);
    if (!health.getHealth(to.id)?.ok) throw fail(503, `${to.name} is unreachable`);

    const plan = items.map(({ databaseId, name }) => ({ databaseId, name }));
    const stepDefs = childSteps(plan, to.id);
    const operation = createOperation({
        type: 'switchover_all',
        serverId: from.id,
        params: { fromServerId: from.id, toServerId: to.id, databases: plan },
        stepDefs,
    });
    events.add('warn', 'failover', `Switching over ${plan.length} database(s) from ${from.name} to ${to.name}`, { serverId: from.id, operationId: operation.id });
    return { operation, done: execute(operation.id, stepDefs, from, to) };
}

export async function resumeSwitchoverAll(op) {
    const from = serversRepo.get(op.params.fromServerId);
    const to = serversRepo.get(op.params.toServerId);
    if (!from || !to) throw fail(409, 'One of the servers no longer exists');
    const stepDefs = childSteps(op.params.databases, to.id);
    events.add('warn', 'failover', `Resuming switch-over #${op.id} from ${from.name} to ${to.name}`, { serverId: from.id, operationId: op.id });
    return { operation: op, done: execute(op.id, stepDefs, from, to) };
}

function execute(opId, stepDefs, from, to) {
    return runOperation(opId, stepDefs).then((op) => {
        if (op.status === 'succeeded') events.add('info', 'failover', `Switch-over from ${from.name} to ${to.name} completed`, { serverId: to.id, operationId: op.id });
        publish('database.changed', {});
        return op;
    });
}
