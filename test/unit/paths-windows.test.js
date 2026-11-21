// SQL Servers on Windows (drive letters, UNC shares, named instances) next to
// Linux ones: path translation, MOVE targets, undo files, server validation
// and connection settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePath, isWindowsPath, isOwnBackupPath, sqlPathApi } from '../../src/paths.js';
import { buildMoves, undoFilePath } from '../../src/engine/restore-plan.js';
import { validate } from '../../src/store/repos/servers.js';
import { poolConfig } from '../../src/sql/pool.js';

const REL = 'Sales/LOG/Sales_LOG_20261121_131046_sql1.trn';
const drive = { name: 'win1', sql_backup_root: 'D:\\Backup' };
const unc = { name: 'win2', sql_backup_root: '\\\\fileserver\\sqlbackup' };
const linux = { name: 'sql1', sql_backup_root: '/var/opt/mssql/backup' };
const rel = (p, s) => translatePath(p, s, { from: 'sql', to: 'rel' });
const sqlOf = (p, s) => translatePath(p, s, { from: 'rel', to: 'sql' });

test('Windows paths are recognized: drive letters and UNC, not relative or POSIX', () => {
    for (const p of ['C:\\', 'D:\\Backup', 'd:/backup', '\\\\host\\share', '\\\\host\\share\\x']) assert.equal(isWindowsPath(p), true, p);
    for (const p of ['/var/opt/mssql', 'C:x', 'Backup', '\\\\host', '', null]) assert.equal(isWindowsPath(p), false, String(p));
});

test('one relative path, translated for each server in its own style', () => {
    assert.equal(sqlOf(REL, drive), 'D:\\Backup\\Sales\\LOG\\Sales_LOG_20261121_131046_sql1.trn');
    assert.equal(sqlOf(REL, unc), '\\\\fileserver\\sqlbackup\\Sales\\LOG\\Sales_LOG_20261121_131046_sql1.trn');
    assert.equal(sqlOf(REL, linux), '/var/opt/mssql/backup/Sales/LOG/Sales_LOG_20261121_131046_sql1.trn');
    assert.equal(sqlOf('Sales/FULL/x.bak', { sql_backup_root: 'E:\\' }), 'E:\\Sales\\FULL\\x.bak');
});

test('Windows paths from msdb map back: either separator, any letter case', () => {
    assert.equal(rel('D:\\Backup\\Sales\\LOG\\x.trn', drive), 'Sales/LOG/x.trn');
    assert.equal(rel('d:/backup/Sales/LOG/x.trn', drive), 'Sales/LOG/x.trn');
    assert.equal(rel('\\\\FILESERVER\\SqlBackup\\Sales\\FULL\\y.bak', unc), 'Sales/FULL/y.bak');
    assert.equal(rel(sqlOf(REL, unc), unc), REL, 'round trip');
});

test('paths outside the root, or escaping it, are refused', () => {
    assert.throws(() => rel('D:\\Other\\x.trn', drive), /not under/);
    assert.throws(() => rel('D:\\Backup2\\x.trn', drive), /not under/, 'a sibling folder with the same prefix');
    assert.throws(() => rel('D:\\Backup\\..\\x.trn', drive), /not under|escapes/);
    assert.throws(() => rel('\\\\otherserver\\sqlbackup\\x.trn', unc), /not under/);
});

test("backups Mostly On wrote are recognized on Windows servers, others are not", () => {
    assert.equal(isOwnBackupPath('D:\\Backup\\Sales\\LOG\\Sales_LOG_20261121_131046_sql1.trn', drive), true);
    assert.equal(isOwnBackupPath('d:/backup/Sales/FULL/Sales_FULL_20261121_131046_sql1.bak', drive), true);
    assert.equal(isOwnBackupPath('D:\\Backup\\manual.bak', drive), false);
    assert.equal(isOwnBackupPath('C:\\Temp\\Sales_LOG_20261121_131046_sql1.trn', drive), false);
});

test('MOVE targets and the undo file use the target server\'s path style', () => {
    const files = [
        { logicalName: 'Sales', physicalName: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\DATA\\Sales.mdf', type: 'D', fileId: 1 },
        { logicalName: 'Sales_log', physicalName: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\DATA\\Sales_log.ldf', type: 'L', fileId: 2 },
    ];
    const winData = 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\DATA\\';
    assert.deepEqual(buildMoves(files, { defaultDataPath: winData, defaultLogPath: winData, dbName: 'Sales' }), [
        { from: 'Sales', to: `${winData}Sales.mdf` },
        { from: 'Sales_log', to: `${winData}Sales_log.ldf` },
    ]);
    // A Windows backup restored on Linux: file names from the Windows paths, POSIX folders.
    assert.deepEqual(buildMoves(files, { defaultDataPath: '/var/opt/mssql/data/', defaultLogPath: '/var/opt/mssql/data/', dbName: 'Sales' }), [
        { from: 'Sales', to: '/var/opt/mssql/data/Sales.mdf' },
        { from: 'Sales_log', to: '/var/opt/mssql/data/Sales_log.ldf' },
    ]);
    assert.equal(undoFilePath({ name: 'win1', default_data_path: winData }, 'Sales'), `${winData}Sales.tuf`);
    assert.equal(undoFilePath({ name: 'win1', standby_root: 'E:\\Standby' }, 'Sales'), 'E:\\Standby\\Sales.tuf');
    assert.equal(sqlPathApi('E:\\x').sep, '\\');
});

test('server settings accept Windows SQL Server paths (normalized) but not for Mostly On itself', () => {
    const base = { name: 'win1', host: 'winvm', username: 'mostly_on', password: 'x' };
    assert.equal(validate({ ...base, sql_backup_root: 'D:/Backup/' }).sql_backup_root, 'D:\\Backup');
    assert.equal(validate({ ...base, sql_backup_root: '\\\\fs\\share\\sql\\' }).sql_backup_root, '\\\\fs\\share\\sql');
    assert.equal(validate({ ...base, sql_backup_root: 'C:\\' }).sql_backup_root, 'C:\\');
    assert.equal(validate({ ...base, sql_backup_root: '/x', standby_root: 'E:\\Standby' }).standby_root, 'E:\\Standby');
    for (const bad of ['D:Backup', 'Backup', 'D:\\a\\..\\b']) assert.throws(() => validate({ ...base, sql_backup_root: bad }), /absolute path/, bad);
    assert.throws(() => validate({ ...base, sql_backup_root: '/x', controller_backup_root: 'D:\\Backup' }), /such as \/backup/);
});

test('named instances: validated, and the driver gets the instance instead of the port', () => {
    const base = { name: 'win1', host: 'winvm', username: 'mostly_on', password: 'x', sql_backup_root: 'D:\\Backup' };
    assert.equal(validate({ ...base, instance_name: 'SQLEXPRESS' }).instance_name, 'SQLEXPRESS');
    assert.equal(validate({ ...base, instance_name: '' }).instance_name, null);
    assert.throws(() => validate({ ...base, instance_name: 'two words' }), /instance name/);
    assert.throws(() => validate({ ...base, instance_name: 'A23456789012345678' }), /instance name/);

    const named = poolConfig({ host: 'winvm', port: 1433, instance_name: 'PROD', username: 'mostly_on', password: 'x', encrypt: true, trust_server_cert: true });
    assert.equal(named.port, undefined);
    assert.equal(named.options.instanceName, 'PROD');
    const plain = poolConfig({ host: 'sql1', port: 14331, instance_name: null, username: 'mostly_on', password: 'x' });
    assert.equal(plain.port, 14331);
    assert.equal(plain.options.instanceName, undefined);
});
