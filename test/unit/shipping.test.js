import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLog, lag, chainGap, retentionPlan } from '../../src/engine/chain.js';
import { buildMoves, undoFilePath, classifyRestoreError, backoffMs } from '../../src/engine/restore-plan.js';
import { checkLive } from '../../src/engine/restore-loop.js';

let nextId = 1;
const file = (type, first, last, extra = {}) => ({
    id: nextId++,
    type,
    rel_path: `Sales/${type}/${type}_${nextId}.${type === 'LOG' ? 'trn' : 'bak'}`,
    first_lsn: String(first),
    last_lsn: String(last),
    first_recovery_fork_guid: 'fork-a',
    backup_finish: new Date(Date.UTC(2026, 10, 20, 10, nextId)).toISOString(),
    file_status: 'present',
    ...extra,
});

function chain() {
    nextId = 1;
    const full = file('FULL', 100, 150);
    const l1 = file('LOG', 100, 200);
    const l2 = file('LOG', 200, 300);
    const l3 = file('LOG', 300, 400);
    return { full, l1, l2, l3, files: [full, l1, l2, l3] };
}

test('next log covers the position (first_lsn <= pos < last_lsn)', () => {
    const c = chain();
    assert.equal(nextLog({ files: c.files, position: '150' }).file.id, c.l1.id, 'log taken during the full covers the full\'s end');
    assert.equal(nextLog({ files: c.files, position: '200' }).file.id, c.l2.id, 'boundary belongs to the next log');
    assert.equal(nextLog({ files: c.files, position: '399' }).file.id, c.l3.id);
    assert.equal(nextLog({ files: c.files, position: '400' }).status, 'caught_up');
});

test('a gap marks the chain broken instead of skipping ahead', () => {
    const c = chain();
    const files = [c.full, c.l1, c.l3]; // l2 never cataloged (foreign log backup)
    const r = nextLog({ files, position: '200' });
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /A log backup is missing.*stopped at LSN 200/);
    assert.match(r.reason, /starts at LSN 300/);
});

test('missing or deleted next file is broken, never skipped', () => {
    const c = chain();
    c.l2.file_status = 'missing';
    assert.match(nextLog({ files: c.files, position: '200' }).reason, /missing from disk/);
    c.l2.file_status = 'deleted';
    assert.match(nextLog({ files: c.files, position: '200' }).reason, /deleted/);
});

test('empty log backups (first_lsn = last_lsn) are neither needed nor a gap', () => {
    const c = chain();
    const empty = file('LOG', 400, 400);
    assert.equal(nextLog({ files: [...c.files, empty], position: '400' }).status, 'caught_up');
});

test('two candidates: the one on the replica\'s fork wins; otherwise refuse to guess', () => {
    const c = chain();
    const other = file('LOG', 200, 350, { first_recovery_fork_guid: 'fork-b' });
    const files = [...c.files, other];
    assert.equal(nextLog({ files, position: '250', forkGuid: 'fork-a' }).file.id, c.l2.id);
    assert.equal(nextLog({ files, position: '250', forkGuid: 'fork-b' }).file.id, other.id);
    assert.equal(nextLog({ files, position: '250' }).status, 'broken');
});

test('LSNs beyond 2^53 are compared exactly', () => {
    nextId = 1;
    const a = file('LOG', '44000000032000001', '44000000037600001');
    const b = file('LOG', '44000000037600001', '44000000037600003');
    assert.equal(nextLog({ files: [a, b], position: '44000000037600002' }).file.id, b.id);
    assert.equal(nextLog({ files: [a, b], position: '44000000037600003' }).status, 'caught_up');
});

test('chainGap walks the whole chain from a base position', () => {
    const c = chain();
    assert.equal(chainGap(c.files, '150'), null);
    assert.match(chainGap([c.full, c.l1, c.l3], '150'), /stopped at LSN 200/);
});

test('lag counts unrestored logs and ages the last restored backup', () => {
    const c = chain();
    const now = new Date(new Date(c.l1.backup_finish).getTime() + 90_000);
    const l = lag({ files: c.files, position: '200', now });
    assert.equal(l.files, 2);
    assert.equal(l.lastRestored.id, c.l1.id);
    assert.equal(l.seconds, 90);
    assert.equal(lag({ files: c.files, position: '400', now }).files, 0);
    assert.equal(lag({ files: c.files, position: '150', now }).lastRestored.type, 'FULL', 'right after seeding the FULL is the last restored backup');
    assert.deepEqual(lag({ files: c.files, position: null }), { files: null, seconds: null, lastRestored: null });
});

test('retention: a seeding secondary without a position does not block; with one it protects', () => {
    const c = chain();
    const days = { FULL: 0, DIFF: 0, LOG: 0 };
    const now = new Date(Date.UTC(2027, 0, 1));
    const seeding = retentionPlan({ files: c.files, secondaries: [{ server_id: 2, role: 'secondary', chain_state: 'seeding', position_lsn: null }], retentionDays: days, now });
    assert.equal(seeding.blocked, null);
    const positioned = retentionPlan({ files: c.files, secondaries: [{ server_id: 2, role: 'secondary', chain_state: 'seeding', position_lsn: '150' }], retentionDays: days, now });
    assert.ok(positioned.protectedIds.has(c.l1.id));
    const shipping = retentionPlan({ files: c.files, secondaries: [{ server_id: 2, role: 'secondary', chain_state: 'ok', position_lsn: null }], retentionDays: days, now });
    assert.match(shipping.blocked, /no known restore position/);
});

test('retention: a secondary that needs a reseed protects nothing', () => {
    const c = chain();
    const oldFull = file('FULL', 10, 20, { backup_finish: '2026-01-01T00:00:00.000Z' });
    const oldLog = file('LOG', 10, 90, { backup_finish: '2026-01-01T00:00:00.000Z' });
    const files = [oldFull, oldLog, ...c.files];
    const now = new Date(Date.UTC(2027, 0, 1));
    const plan = retentionPlan({ files, secondaries: [{ server_id: 2, role: 'secondary', chain_state: 'needs_reseed', position_lsn: '15' }], retentionDays: { FULL: 1, DIFF: 1, LOG: 1 }, now });
    assert.ok(plan.deletable.some((f) => f.id === oldLog.id));
});

test('MOVE targets use the target default paths and keep the primary file names', () => {
    const moves = buildMoves(
        [
            { logicalName: 'Sales', physicalName: '/var/opt/mssql/data/Sales.mdf', type: 'D', fileId: 1 },
            { logicalName: 'Sales_2', physicalName: '/other/dir/Sales.mdf', type: 'D', fileId: 3 },
            { logicalName: 'Sales_log', physicalName: 'C:\\SQL\\Logs\\Sales_log.ldf', type: 'L', fileId: 2 },
            { logicalName: 'Weird', physicalName: '/data/we ird;name.ndf', type: 'D', fileId: 4 },
        ],
        { defaultDataPath: '/data/', defaultLogPath: '/logs', dbName: 'Sales' },
    );
    assert.deepEqual(moves, [
        { from: 'Sales', to: '/data/Sales.mdf' },
        { from: 'Sales_2', to: '/data/Sales_3.mdf' },
        { from: 'Sales_log', to: '/logs/Sales_log.ldf' },
        { from: 'Weird', to: '/data/Sales_Weird.ndf' },
    ]);
    assert.throws(() => buildMoves([{ logicalName: 'ft', physicalName: '/x', type: 'F', fileId: 9 }], { defaultDataPath: '/d', defaultLogPath: '/l', dbName: 'x' }), /type F/);
    assert.throws(() => buildMoves([], { defaultDataPath: null, defaultLogPath: '/l', dbName: 'x' }), /default data and log paths/);
});

test('STANDBY undo file goes to standby_root, else the default data path', () => {
    assert.equal(undoFilePath({ standby_root: '/standby', default_data_path: '/data' }, 'Sales'), '/standby/Sales.tuf');
    assert.equal(undoFilePath({ standby_root: null, default_data_path: '/data/' }, 'Sales'), '/data/Sales.tuf');
    assert.match(undoFilePath({ default_data_path: '/data' }, '../x y'), /^\/data\/[^/]+~[0-9a-f]{8}\.tuf$/, 'unsafe names are sanitized and cannot escape the directory');
    assert.throws(() => undoFilePath({ name: 'x' }, 'Sales'), /no standby path/);
});

test('restore errors are classified by SQL error number, including preceding errors', () => {
    const err = (n, pre = []) => ({ number: 3013, precedingErrors: [{ number: n }, ...pre] });
    assert.equal(classifyRestoreError(err(4326)), 'already_applied');
    assert.equal(classifyRestoreError(err(4305)), 'too_recent');
    assert.equal(classifyRestoreError(err(3201)), 'cannot_open');
    assert.equal(classifyRestoreError(err(3101)), 'in_use');
    assert.equal(classifyRestoreError({ code: 'ESOCKET' }), 'connection');
    assert.equal(classifyRestoreError({ number: 9002 }), 'other');
});

test('backoff grows and is capped', () => {
    assert.equal(backoffMs(1), 30_000);
    assert.equal(backoffMs(2), 60_000);
    assert.equal(backoffMs(99), 900_000);
});


test('live-state check: recovered, missing or replaced copies need a reseed; OFFLINE is retried', () => {
    const db = { name: 'Sales', family_guid: 'fam' };
    const server = { name: 'sql2' };
    const ok = { restoring: true, state: 'RESTORING', familyGuid: 'fam', position: '100' };
    assert.equal(checkLive(db, server, ok), null);
    assert.match(checkLive(db, server, null).reseed, /does not exist/);
    assert.match(checkLive(db, server, { ...ok, restoring: false, state: 'ONLINE' }).reseed, /brought online/);
    assert.match(checkLive(db, server, { ...ok, familyGuid: 'other' }).reseed, /different database/);
    assert.match(checkLive(db, server, { ...ok, restoring: false, state: 'OFFLINE' }).retry, /OFFLINE/);
    assert.equal(checkLive(db, server, { ...ok, restoring: true, state: 'ONLINE', standby: true }), null, 'STANDBY counts as restoring');
});
