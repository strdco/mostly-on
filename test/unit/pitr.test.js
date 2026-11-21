// Point-in-time restore: which moments can be restored, which backups a
// restore to one of them needs (src/engine/chain.js), and where the restored
// files go (src/engine/restore-plan.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restorableRange, pointInTimePlan, stopReached, stopAtLocal } from '../../src/engine/chain.js';
import { copyMoves, inPlaceMoves } from '../../src/engine/restore-plan.js';

const at = (min, sec = 0) => new Date(Date.UTC(2026, 10, 21, 12, min, sec)).toISOString();
let nextId = 1;
function file(type, first, last, startMin, { finishMin = startMin, base = null, uuid = null, status = 'present', fork = null, firstFork = null } = {}) {
    const id = nextId++;
    return {
        id,
        type,
        first_lsn: String(first),
        last_lsn: String(last),
        backup_set_uuid: uuid || `u${id}`,
        differential_base_guid: base,
        backup_start: at(startMin),
        backup_finish: at(finishMin),
        file_status: status,
        recovery_fork_guid: fork,
        first_recovery_fork_guid: firstFork ?? fork,
        rel_path: `Sales/${type}/f${id}`,
    };
}

// FULL at 12:00, logs every 10 minutes, a DIFF at 12:25.
function chain() {
    const full = file('FULL', 100, 110, 0, { uuid: 'F1' });
    return {
        full,
        l1: file('LOG', 100, 200, 10),
        l2: file('LOG', 200, 300, 20),
        diff: file('DIFF', 300, 310, 25, { base: 'F1' }),
        l3: file('LOG', 300, 400, 30),
        l4: file('LOG', 400, 500, 40),
    };
}
const ids = (files) => files.map((f) => f.id);

test('range: from just after the oldest usable base to the start of the newest log', () => {
    const c = chain();
    const r = restorableRange({ files: Object.values(c) });
    assert.equal(r.problem, null);
    assert.equal(r.from, at(0, 1));
    assert.equal(r.to, at(40));
    assert.equal(r.newestLog.id, c.l4.id);
});

test('range: a log missing early on moves the start to the first base after the gap', () => {
    const c = chain();
    c.l2.file_status = 'deleted';
    const r = restorableRange({ files: Object.values(c) });
    assert.equal(r.from, at(25, 1), 'the DIFF (12:25) bridges the deleted log');
    c.diff.file_status = 'missing';
    const none = restorableRange({ files: Object.values(c) });
    assert.equal(none.from, null);
    assert.match(none.problem, /deleted/);
});

test('range: a FULL without logs after it yet has no end (a fresh log backup is needed)', () => {
    const r = restorableRange({ files: [file('FULL', 100, 110, 0)] });
    assert.equal(r.from, at(0, 1));
    assert.equal(r.to, null);
    assert.match(restorableRange({ files: [] }).problem, /no FULL/);
});

test('plan: newest base before the moment, then logs up to the first one that surely holds it', () => {
    const c = chain();
    const files = Object.values(c);
    let p = pointInTimePlan({ files, at: at(15) });
    assert.equal(p.problem, null);
    assert.equal(p.full.id, c.full.id);
    assert.equal(p.diff, null);
    assert.deepEqual(ids(p.logs), [c.l1.id, c.l2.id], 'L1 started before 12:15, L2 after');

    p = pointInTimePlan({ files, at: at(33) });
    assert.equal(p.diff.id, c.diff.id, 'the DIFF from 12:25 shortens the chain');
    assert.deepEqual(ids(p.logs), [c.l3.id, c.l4.id], 'logs from the DIFF on: L3 ends at LSN 400, L4 starts after 12:33');

    p = pointInTimePlan({ files, at: at(25, 0) });
    assert.equal(p.diff, null, 'a DIFF that finished in the same second is not before the moment');
});

test('plan: a moment after the newest log start needs a fresh log backup; one before the FULL is refused', () => {
    const files = Object.values(chain());
    assert.match(pointInTimePlan({ files, at: at(45) }).problem, /new log backup is needed/);
    assert.match(pointInTimePlan({ files, at: at(0) }).problem, /no FULL backup from before/);
    assert.match(pointInTimePlan({ files, at: 'yesterday' }).problem, /not a valid moment/);
});

test('plan: a deleted log between the base and the moment is reported, not skipped', () => {
    const c = chain();
    c.l1.file_status = 'deleted';
    const p = pointInTimePlan({ files: Object.values(c), at: at(15) });
    assert.match(p.problem, /deleted/);
});

test('plan: after a failover, logs abandoned on the old branch are not used', () => {
    // FULL and L1 on fork A; the new primary recovered at LSN 250 (fork B).
    // L2 (A, 200-300) went past the branch point; L2b crosses from A to B at 250.
    const full = file('FULL', 100, 110, 0, { fork: 'A' });
    const l1 = file('LOG', 100, 200, 10, { fork: 'A' });
    const l2 = file('LOG', 200, 300, 20, { fork: 'A' });
    const l2b = file('LOG', 200, 320, 22, { fork: 'B', firstFork: 'A' });
    const l3 = file('LOG', 320, 400, 30, { fork: 'B' });
    const lineage = [
        { fork_guid: 'A', fork_point_lsn: null },
        { fork_guid: 'B', fork_point_lsn: '250' },
    ];
    const p = pointInTimePlan({ files: [full, l1, l2, l2b, l3], lineage, at: at(25) });
    assert.equal(p.problem, null);
    assert.deepEqual(ids(p.logs), [l1.id, l2b.id, l3.id]);
});

test('stop detection: a database that stopped inside a log is done', () => {
    const log = { first_lsn: '200', last_lsn: '300' };
    assert.equal(stopReached('250', log), true);
    assert.equal(stopReached('300', log), false, 'the whole log came before the moment: restore the next one');
    assert.equal(stopReached(null, log), false);
});

test("STOPAT is given in the writing server's local time", () => {
    const utc = '2026-11-21T12:15:00.000Z';
    assert.equal(stopAtLocal(utc, 60).toISOString(), '2026-11-21T13:15:00.000Z', 'UTC+1: the server reads 13:15');
    assert.equal(stopAtLocal(utc, -300).toISOString(), '2026-11-21T07:15:00.000Z');
    assert.equal(stopAtLocal(utc, null).toISOString(), utc);
});

const list = [
    { logicalName: 'Sales', physicalName: 'C:\\SQL\\DATA\\Sales.mdf', type: 'D', fileId: 1 },
    { logicalName: 'Sales_log', physicalName: 'C:\\SQL\\DATA\\Sales_log.ldf', type: 'L', fileId: 2 },
    { logicalName: 'Archive', physicalName: 'C:\\SQL\\DATA\\Sales_archive.ndf', type: 'D', fileId: 3 },
];

test('a copy gets file names of its own, so it never collides with the original', () => {
    assert.deepEqual(copyMoves(list, { defaultDataPath: '/var/opt/mssql/data', defaultLogPath: '/var/opt/mssql/log', newName: 'Sales_20261121_1215' }), [
        { from: 'Sales', to: '/var/opt/mssql/data/Sales_20261121_1215.mdf' },
        { from: 'Sales_log', to: '/var/opt/mssql/log/Sales_20261121_1215_log.ldf' },
        { from: 'Archive', to: '/var/opt/mssql/data/Sales_20261121_1215_Archive.ndf' },
    ]);
    const win = copyMoves(list.slice(0, 1), { defaultDataPath: 'D:\\Data\\', defaultLogPath: 'D:\\Data\\', newName: 'Sales_old' });
    assert.equal(win[0].to, 'D:\\Data\\Sales_old.mdf');
});

test('a rollback restores every file where the database keeps it now', () => {
    const target = { defaultDataPath: '/var/opt/mssql/data/', defaultLogPath: '/var/opt/mssql/data/', dbName: 'Sales' };
    // The same server took the FULL: the backup already names the current files.
    const same = list.map((f) => ({ logicalName: f.logicalName, physicalName: f.physicalName }));
    assert.deepEqual(inPlaceMoves(list, same, target), []);
    // A secondary on Linux (seeded with buildMoves); the archive file is new since then.
    const linux = [
        { logicalName: 'Sales', physicalName: '/var/opt/mssql/data/Sales.mdf' },
        { logicalName: 'SALES_LOG', physicalName: '/var/opt/mssql/data/Sales_log.ldf' },
    ];
    assert.deepEqual(inPlaceMoves(list, linux, target), [
        { from: 'Sales', to: '/var/opt/mssql/data/Sales.mdf' },
        { from: 'Sales_log', to: '/var/opt/mssql/data/Sales_log.ldf' },
        { from: 'Archive', to: '/var/opt/mssql/data/Sales_archive.ndf' },
    ]);
});
