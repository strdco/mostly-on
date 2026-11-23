// Backups-only databases (system databases, and user databases not in FULL
// recovery): how a database is managed, and which backup types apply now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manageKind, backupTypeProblem, skippedTypes, dbLabel, isBackupOnly } from '../../src/engine/backup-rules.js';

test('how a database is managed', () => {
    assert.equal(manageKind({ databaseId: 9, recoveryModel: 'FULL' }), 'shipped');
    assert.equal(manageKind({ databaseId: 9, recoveryModel: 'SIMPLE' }), 'backup_only');
    assert.equal(manageKind({ databaseId: 9, recoveryModel: 'BULK_LOGGED' }), 'backup_only');
    for (const id of [1, 3, 4]) assert.equal(manageKind({ databaseId: id, recoveryModel: 'FULL' }), 'backup_only', `system database ${id}`);
    assert.equal(manageKind({ name: 'MSDB', recoveryModel: 'FULL' }), 'backup_only', 'by name when the id is unknown');
    assert.equal(manageKind({ databaseId: 9, name: 'master', recoveryModel: 'FULL' }), 'shipped', 'the id wins over a name');
});

test('labels', () => {
    const local = { name: 'master', backup_only_server_id: 3, backup_only_server_name: 'sql1' };
    assert.equal(isBackupOnly(local), true);
    assert.equal(dbLabel(local), 'master on sql1');
    assert.equal(dbLabel({ name: 'Sales', backup_only_server_id: null }), 'Sales');
});

test('which backup types apply now', () => {
    const shipped = { name: 'Sales', backup_only_server_id: null };
    const local = { name: 'Util', backup_only_server_id: 1 };
    const master = { name: 'master', backup_only_server_id: 1 };
    const live = (recoveryModel, databaseId = 9) => ({ recoveryModel, databaseId });

    for (const db of [shipped, local, master]) assert.equal(backupTypeProblem(db, live('SIMPLE', db === master ? 1 : 9), 'FULL', 's'), null, 'a FULL always applies');
    assert.equal(backupTypeProblem(shipped, live('FULL'), 'LOG', 's'), null);
    assert.equal(backupTypeProblem(local, live('FULL'), 'LOG', 's'), null, 'a backups-only database in FULL recovery gets LOG backups');
    assert.equal(backupTypeProblem(local, live('FULL'), 'DIFF', 's'), null);

    // A log-shipped database that left FULL recovery: a real problem, as before.
    assert.deepEqual(backupTypeProblem(shipped, live('SIMPLE'), 'LOG', 'sql1'), { skip: false, message: 'Database Sales is in SIMPLE recovery on sql1; log shipping needs FULL' });

    // A backups-only database not in FULL recovery: skipped.
    const p = backupTypeProblem(local, live('BULK_LOGGED'), 'LOG', 'sql1');
    assert.equal(p.skip, true);
    assert.equal(p.status, 'skipped: BULK_LOGGED recovery');
    assert.match(p.message, /Util on sql1 is in BULK_LOGGED recovery, so Mostly-On only takes FULL backups of it/);

    // master: FULL only, whatever its recovery model.
    for (const type of ['DIFF', 'LOG']) assert.deepEqual(backupTypeProblem(master, live('FULL', 1), type, 's').skip, true);
    assert.equal(backupTypeProblem(master, {}, 'LOG', 's').skip, true, 'by name when the server could not be asked');

    // Unknown recovery model (server unreachable): no opinion; the backup fails on its own.
    assert.equal(backupTypeProblem(local, {}, 'LOG', 's'), null);

    assert.deepEqual(Object.keys(skippedTypes(local, live('SIMPLE'), 's')), ['DIFF', 'LOG']);
    assert.deepEqual(skippedTypes(local, live('FULL'), 's'), {});
    assert.deepEqual(skippedTypes(shipped, live('SIMPLE'), 's'), {}, 'never skipped quietly');
});
