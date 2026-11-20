import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupRelPath, translatePath, safeName, normalizeRel, isOwnBackupPath } from '../../src/paths.js';

const server = { sql_backup_root: '/var/opt/mssql/backup', controller_backup_root: null };
const opts = { controllerRoot: '/backup' };

test('backup file naming follows the layout', () => {
    const d = new Date(Date.UTC(2026, 10, 20, 9, 5, 7));
    assert.equal(backupRelPath('Sales', 'LOG', d, 'sql1'), 'Sales/LOG/Sales_LOG_20261120_090507_sql1.trn');
    assert.equal(backupRelPath('Sales', 'FULL', d, 'sql1'), 'Sales/FULL/Sales_FULL_20261120_090507_sql1.bak');
    assert.equal(backupRelPath('Sales', 'DIFF', d, 'sql1'), 'Sales/DIFF/Sales_DIFF_20261120_090507_sql1.bak');
});

test('unsafe database names are sanitized with a hash', () => {
    const a = safeName('My DB/../x');
    assert.match(a, /^[A-Za-z0-9_.~-]+$/);
    assert.notEqual(safeName('a b'), safeName('a_b'));
    assert.equal(safeName('a_b'), 'a_b');
    assert.notEqual(safeName('..'), '..');
});

test('translatePath maps between namespaces', () => {
    const rel = 'Sales/LOG/Sales_LOG_20261120_090507_sql1.trn';
    assert.equal(translatePath(rel, server, { from: 'rel', to: 'sql', ...opts }), '/var/opt/mssql/backup/' + rel);
    assert.equal(translatePath(rel, server, { from: 'rel', to: 'controller', ...opts }), '/backup/' + rel);
    assert.equal(translatePath('/var/opt/mssql/backup/' + rel, server, { from: 'sql', to: 'controller', ...opts }), '/backup/' + rel);
    assert.equal(translatePath('/backup/' + rel, server, { from: 'controller', to: 'rel', ...opts }), rel);
    const custom = { ...server, controller_backup_root: '/mnt/shared/' };
    assert.equal(translatePath(rel, custom, { from: 'rel', to: 'controller', ...opts }), '/mnt/shared/' + rel);
});

test('translatePath refuses paths outside the root', () => {
    assert.throws(() => translatePath('/etc/passwd', server, { from: 'sql', to: 'controller', ...opts }));
    assert.throws(() => translatePath('/var/opt/mssql/backupX/a.bak', server, { from: 'sql', to: 'rel', ...opts }));
    assert.throws(() => translatePath('/var/opt/mssql/backup/../data/x.mdf', server, { from: 'sql', to: 'rel', ...opts }));
    assert.throws(() => translatePath('../x', server, { from: 'rel', to: 'controller', ...opts }));
    assert.throws(() => normalizeRel('/abs'));
    assert.throws(() => normalizeRel('a/../../b'));
});

test('isOwnBackupPath recognizes our naming pattern only', () => {
    assert.equal(isOwnBackupPath('/var/opt/mssql/backup/Sales/LOG/Sales_LOG_20261120_090507_sql1.trn', server), true);
    assert.equal(isOwnBackupPath('/var/opt/mssql/backup/manual.trn', server), false);
    assert.equal(isOwnBackupPath('/var/opt/mssql/data/Sales_LOG_20261120_090507_sql1.trn', server), false);
    assert.equal(isOwnBackupPath('NUL', server), false);
});
