// Journaled, step-wise operation runner.
//
// An operation is a list of steps. Each step definition is
//   { name, label, check?(ctx) -> truthy if already done, run(ctx) -> detail }
// Before a step runs its state is persisted as "running"; afterwards as "done"
// (or "skipped" when check() found the work already done, which is what makes
// resuming after a crash safe). On error the step and operation are marked
// failed and nothing is rolled back.
import * as ops from '../store/repos/operations.js';
import * as events from '../store/repos/events.js';
import { publish } from '../bus.js';
import { nowIso } from '../store/db.js';
import { sqlErrorText } from '../sql/pool.js';

function emit(op) {
    publish('operation.updated', {
        id: op.id,
        type: op.type,
        status: op.status,
        databaseId: op.database_id,
        currentStep: op.current_step,
        steps: op.steps,
    });
}

/** Creates the journal entry. Step definitions only need name/label here. */
export function createOperation({ type, databaseId, serverId, parentId, params, stepDefs, ctx = {} }) {
    const op = ops.create({
        type,
        databaseId,
        serverId,
        parentId,
        params,
        ctx,
        status: 'running',
        steps: stepDefs.map((s) => ({ name: s.name, label: s.label || s.name, status: 'pending', ...(s.guidance ? { guidance: s.guidance } : {}) })),
    });
    emit(op);
    return op;
}

/**
 * Runs (or resumes) an operation. Returns the final operation row. Throws
 * nothing for step failures; check the returned status.
 */
export async function runOperation(opId, stepDefs, { quiet = false } = {}) {
    let op = ops.get(opId);
    let steps = op.steps;
    let ctxState = op.ctx;

    const persist = (patch) => {
        op = ops.save(opId, patch);
        emit(op);
    };

    if (op.status !== 'running') persist({ status: 'running', error: null, finished_at: null });

    for (let i = 0; i < stepDefs.length; i++) {
        const def = stepDefs[i];
        const st = steps[i];
        if (st.status === 'done' || st.status === 'skipped') continue;

        st.status = 'running';
        st.started_at = nowIso();
        st.error = undefined;
        persist({ current_step: def.name, steps });

        let lastProgress = 0;
        const ctx = {
            op,
            params: op.params,
            /** The persisted context, including what this step saved so far. */
            get state() {
                return ctxState;
            },
            /** Merge into the persisted operation context (survives a crash). */
            save(patch) {
                ctxState = { ...ctxState, ...patch };
                persist({ ctx: ctxState });
            },
            /** Live progress text for the current step (throttled persistence). */
            progress(text) {
                st.detail = text;
                const now = Date.now();
                if (now - lastProgress > 1000) {
                    lastProgress = now;
                    persist({ steps });
                } else {
                    emit({ ...op, steps });
                }
            },
        };

        try {
            const already = def.check ? await def.check(ctx) : false;
            if (already) {
                st.status = 'skipped';
                st.detail = typeof already === 'string' ? already : 'Already done';
            } else {
                const detail = await def.run(ctx);
                st.status = 'done';
                if (detail !== undefined) st.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
            }
            st.finished_at = nowIso();
            persist({ steps });
        } catch (err) {
            const message = err.number || err.code ? sqlErrorText(err) : err.message;
            st.status = 'failed';
            st.error = message;
            st.finished_at = nowIso();
            persist({ steps, status: 'failed', error: `${def.label || def.name}: ${message}`, finished_at: nowIso() });
            if ((!quiet && !err.quiet) || err.alwaysReport) {
                events.add('error', op.type, `Operation #${op.id} (${op.type}) failed at step "${def.label || def.name}": ${message}`, {
                    databaseId: op.database_id,
                    serverId: op.server_id,
                    operationId: op.id,
                });
            }
            return op;
        }
    }
    persist({ status: 'succeeded', current_step: null, finished_at: nowIso() });
    return op;
}
