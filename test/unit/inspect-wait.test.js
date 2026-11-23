// A database that is starting up (RECOVERING, e.g. AUTO_CLOSE on SQL Server
// Express) is read again for a while before a backup gives up on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitWhileStartingUp } from '../../src/sql/inspect.js';

/** A fake clock and a reader that returns the given states one after the other. */
function fake(states) {
    let t = 0;
    const reads = [];
    return {
        reads,
        read: async () => {
            const s = states[Math.min(reads.length, states.length - 1)];
            reads.push(t);
            return s === null ? null : { state: s };
        },
        opts: { waitMs: 5000, pollMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) },
    };
}

test('returns at once when the database is online, or in a state that is not starting up', async () => {
    for (const s of ['ONLINE', 'RECOVERY_PENDING', 'SUSPECT', 'OFFLINE', null]) {
        const f = fake([s]);
        assert.deepEqual(await waitWhileStartingUp(f.read, f.opts), s === null ? null : { state: s });
        assert.equal(f.reads.length, 1, `${s}: read once`);
    }
});

test('reads again while the database is starting up', async () => {
    const f = fake(['RECOVERING', 'RECOVERING', 'ONLINE']);
    assert.deepEqual(await waitWhileStartingUp(f.read, f.opts), { state: 'ONLINE' });
    assert.deepEqual(f.reads, [0, 1000, 2000]);
});

test('gives up after waitMs and returns the state it last read', async () => {
    const f = fake(['RECOVERING']);
    assert.deepEqual(await waitWhileStartingUp(f.read, f.opts), { state: 'RECOVERING' });
    assert.deepEqual(f.reads, [0, 1000, 2000, 3000, 4000, 5000]);
});
