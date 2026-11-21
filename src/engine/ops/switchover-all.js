// "Fail over databases" from server X to server Y: one planned failover (with
// a tail-log backup) for every database whose primary is X and that has a
// working secondary on Y, run one after the other. Databases without one stay
// on X. The batch stops at the first failure; resuming it resumes that
// failover and then carries on.
import * as databases from '../../store/repos/databases.js';
import * as serversRepo from '../../store/repos/servers.js';
import * as opsRepo from '../../store/repos/operations.js';
import * as events from '../../store/repos/events.js';
import * as health from '../health.js';
import { createOperation, runOperation } from '../operations.js';
import { startPlannedFailover, resumeFailover } from './failover.js';
import { publish } from '../../bus.js';
import { restoreCompatibility } from '../../sqlversion.js';

function fail(status, message, details) {
    return Object.assign(new Error(message), { status, expose: true, details });
}

const major = (serverId) => health.getHealth(serverId)?.info?.majorVersion;

/** Why `to` cannot take over a database right now (null if it can): judged on its copy there. */
function targetProblem(databaseId, to) {
    const rep = databases.replica(databaseId, to.id);
    if (!rep) return `no copy on ${to.name}`;
    if (rep.role === 'diverged') return `the copy on ${to.name} is out of sync`;
    if (rep.role !== 'secondary') return `${to.name} is not a secondary`;
    if (rep.chain_state === 'seeding') return `the copy on ${to.name} is still being set up`;
    if (rep.chain_state === 'needs_reseed') return `the copy on ${to.name} needs reinitializing`;
    if (rep.chain_state !== 'ok') return `shipping to ${to.name} has stopped`;
    return null;
}

const primariesOn = (fromId) => databases.replicasOnServer(fromId).filter((r) => r.role === 'primary');

/**
 * The servers the primaries on `fromId` can fail over to: every other server
 * holding a working secondary of at least one of them, with how many it covers.
 * Best first (most databases, then reachable, then name).
 */
export function switchoverTargets(fromId) {
    const from = serversRepo.get(fromId);
    if (!from || from.removed_at) throw fail(404, 'Server not found');
    const primaries = primariesOn(from.id);
    const targets = serversRepo
        .list()
        .filter((s) => s.id !== from.id && s.enabled)
        .map((s) => ({ id: s.id, name: s.name, reachable: !!health.getHealth(s.id)?.ok, covers: primaries.filter((p) => !targetProblem(p.database_id, s)).length }))
        .filter((t) => t.covers > 0)
        .sort((a, b) => b.covers - a.covers || Number(b.reachable) - Number(a.reachable) || a.name.localeCompare(b.name));
    return { from: { id: from.id, name: from.name, reachable: !!health.getHealth(from.id)?.ok }, total: primaries.length, targets };
}

/**
 * Databases whose primary is `fromId`, and for each whether it moves to `toId`
 * (moves) or stays (problem says why). `note` warns about what a move implies
 * (the old primary cannot follow a newer SQL Server version).
 */
export function switchoverPlan(fromId, toId) {
    const from = serversRepo.get(fromId);
    const to = serversRepo.get(toId);
    if (!from || !to || to.removed_at) throw fail(404, 'Server not found');
    if (from.id === to.id) throw fail(400, 'Pick two different servers');
    const compat = restoreCompatibility(major(to.id), major(from.id));
    const items = primariesOn(from.id).map((r) => {
        const problem = targetProblem(r.database_id, to);
        let note = null;
        if (!problem && Number.isInteger(major(to.id)) && Number.isInteger(major(from.id)) && !compat.ok) {
            note = `afterwards ${from.name} cannot receive its log backups (${compat.reason}) and needs reinitializing before it can take ${r.database_name} back`;
        }
        return { databaseId: r.database_id, name: r.database_name, moves: !problem, problem, note };
    });
    return { from, to, items };
}

function childSteps(plan, toId) {
    return plan.map(({ databaseId, name }) => ({
        name: `db_${databaseId}`,
        label: `Fail over ${name} (with a tail-log backup)`,
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
                started = await startPlannedFailover(databaseId, { serverId: toId, parentId: ctx.op.id });
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
    const plan = items.filter((i) => i.moves).map(({ databaseId, name }) => ({ databaseId, name }));
    if (!plan.length) throw fail(409, `None of the databases on ${from.name} has a working secondary on ${to.name}`);
    if (!health.getHealth(from.id)?.ok) throw fail(409, `${from.name} is unreachable; a failover without data loss needs it. Fail each database over from its own page instead.`);
    if (!health.getHealth(to.id)?.ok) throw fail(503, `${to.name} is unreachable`);

    const staying = items.filter((i) => !i.moves).map((i) => i.name);
    const stepDefs = childSteps(plan, to.id);
    const operation = createOperation({
        type: 'switchover_all',
        serverId: from.id,
        params: { fromServerId: from.id, toServerId: to.id, databases: plan, staying },
        stepDefs,
    });
    const stays = staying.length ? `; ${staying.length} stay${staying.length === 1 ? 's' : ''} on ${from.name} (no working secondary on ${to.name})` : '';
    events.add('warn', 'failover', `Failing over ${plan.length} database(s) from ${from.name} to ${to.name}${stays}`, { serverId: from.id, operationId: operation.id });
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
