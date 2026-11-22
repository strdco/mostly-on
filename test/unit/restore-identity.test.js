// A cataloged backup is only restored if its file still holds that backup
// (wrongBackupReason in src/engine/restore.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrongBackupReason } from '../../src/engine/restore.js';

const file = { rel_path: 'Sales/LOG/Sales_LOG_20261122_100000_sql1.trn', backup_set_uuid: '52AFDA91-1245-4F7F-8CDF-9E6CC62647CF' };
const header = (position, backupSetGuid) => ({ position, backupSetGuid });

test('the backup the catalog recorded is accepted, whatever was appended after it', () => {
    assert.equal(wrongBackupReason(file, [header(1, '52afda91-1245-4f7f-8cdf-9e6cc62647cf')]), null);
    assert.equal(wrongBackupReason(file, [header(1, '52afda91-1245-4f7f-8cdf-9e6cc62647cf'), header(2, 'ed5df268-7717-4e97-8728-7620279ac42b')]), null);
});

test('a file overwritten with another backup, or holding none, is refused', () => {
    assert.match(wrongBackupReason(file, [header(1, '45d1be5b-dd4e-4389-add0-4e7a8bd7b2f9')]), /no longer holds the backup Mostly-On took .*now holds 45d1be5b/);
    assert.match(wrongBackupReason(file, []), /now holds no backup/);
    // Only the first backup set counts: that is the one RESTORE uses.
    assert.match(wrongBackupReason(file, [header(1, '45d1be5b-dd4e-4389-add0-4e7a8bd7b2f9'), header(2, '52afda91-1245-4f7f-8cdf-9e6cc62647cf')]), /no longer holds/);
});

test('a catalog row without a backup set GUID is not checked', () => {
    assert.equal(wrongBackupReason({ ...file, backup_set_uuid: null }, []), null);
});
