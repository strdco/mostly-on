// Calls to the signed helper procedures (src/sql/privileged.js) and the
// server readiness check (inspect.classifyHelperStatus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/sql/privileged.js';
import { classifyHelperStatus } from '../../src/sql/inspect.js';

/** The text may only name the procedure and pass @parameters: no values, names or paths. */
function assertOnlyPlaceholders(c, proc) {
    const names = Object.keys(c.params);
    assert.equal(c.text, `EXEC master.mostly_on.${proc} ${names.map((n) => `@${n}=@${n}`).join(', ')};`);
}

test('every action is an EXEC of a helper procedure with parameters only', () => {
    const evil = "Sales'; DROP DATABASE x; --";
    assertOnlyPlaceholders(P.takeBackup({ db: evil, type: 'LOG', path: '/b/x.trn', name: 'n', description: 'd' }), 'take_backup');
    assertOnlyPlaceholders(P.tailLog({ db: evil, path: '/b/t.trn', name: 'n', description: 'd', mode: 'planned' }), 'tail_log');
    assertOnlyPlaceholders(P.restoreDatabase({ db: evil, path: '/b/f.bak', moves: [{ from: 'a', to: '/d/a.mdf' }], replace: true }), 'restore_database');
    assertOnlyPlaceholders(P.restoreLog({ db: evil, path: '/b/l.trn', undo: '/d/x.tuf' }), 'restore_log');
    assertOnlyPlaceholders(P.recover({ db: evil, ownerSid: '0x01', ownerName: 'sa' }), 'recover');
    assertOnlyPlaceholders(P.setState({ db: evil, state: 'OFFLINE' }), 'set_state');
    assertOnlyPlaceholders(P.headerOnly({ path: '/b/f.bak' }), 'header_only');
    assertOnlyPlaceholders(P.fileListOnly({ path: '/b/f.bak' }), 'filelist_only');
    assertOnlyPlaceholders(P.purgeBackupHistory({ keepDays: 90 }), 'purge_backup_history');
});

test('MOVE targets travel as one JSON parameter', () => {
    const c = P.restoreDatabase({ db: 'Sales', path: '/b/f.bak', moves: [{ from: "it's", to: '/d/x.mdf', extra: 1 }] });
    assert.deepEqual(JSON.parse(c.params.moves.value), [{ from: "it's", to: '/d/x.mdf' }]);
    assert.equal(c.params.replace.value, 0);
});

test('the owner SID is sent as binary', () => {
    const c = P.recover({ db: 'Sales', ownerSid: '0x0105000000000005150000004A', ownerName: 'DOMAIN\\app' });
    assert.deepEqual(c.params.owner_sid.value, Buffer.from('0105000000000005150000004A', 'hex'));
    assert.equal(P.recover({ db: 'Sales' }).params.owner_sid.value, null);
});

const ready = { helper_version: P.HELPER_VERSION, procedures: 11, signed_procedures: 11, can_execute: 1, view_server_state: 1, view_any_definition: 1, read_msdb: 1, is_sysadmin: 0, login_name: 'mostly_on' };

test('readiness: ready, missing, out of date, unsigned, no permissions', () => {
    assert.deepEqual(classifyHelperStatus(ready).problems, []);
    assert.equal(classifyHelperStatus(ready).ready, true);
    assert.match(classifyHelperStatus({ ...ready, helper_version: null }).problems[0], /not installed/);
    assert.match(classifyHelperStatus({ ...ready, helper_version: P.HELPER_VERSION - 1 }).problems[0], /needs version/);
    assert.match(classifyHelperStatus({ ...ready, signed_procedures: 10 }).problems[0], /no longer signed/);
    assert.match(classifyHelperStatus({ ...ready, can_execute: 0 }).problems[0], /may not run/);
    assert.match(classifyHelperStatus({ ...ready, read_msdb: 0 }).problems[0], /read permissions/);
});

test('readiness: a new login, before the script has run, is only told to run it', () => {
    const fresh = { helper_version: null, procedures: 0, signed_procedures: 0, can_execute: 0, view_server_state: 0, view_any_definition: 0, read_msdb: 1, is_sysadmin: 0, login_name: 'mostly_on' };
    assert.deepEqual(classifyHelperStatus(fresh).problems, ['the helper procedures are not installed.']);
});

test('readiness: a backup or undo-file folder changed after setup needs the script again', () => {
    const run = { ...ready, setup_backup_root: '/var/opt/mssql/backup', setup_standby_root: null };
    const server = { sql_backup_root: '/var/opt/mssql/backup', standby_root: null };
    assert.equal(classifyHelperStatus(run, server).ready, true);
    // The folder was changed to C:\Backup in Mostly-On, but the script was not run again.
    const moved = classifyHelperStatus(run, { ...server, sql_backup_root: 'C:\\Backup' });
    assert.equal(moved.ready, false);
    assert.match(moved.problems[0], /last run with the shared backup folder \/var\/opt\/mssql\/backup, but this server's settings in Mostly-On say C:\\Backup/);
    assert.match(classifyHelperStatus(run, { ...server, standby_root: '/var/opt/mssql/standby' }).problems[0], /the default data folder as the folder for undo files/);
    // The same folder written differently is the same folder.
    const win = { ...ready, setup_backup_root: 'c:/backup\\', setup_standby_root: '\\\\FS\\Undo' };
    assert.equal(classifyHelperStatus(win, { sql_backup_root: 'C:\\Backup', standby_root: '\\\\fs\\undo' }).ready, true);
    // An older helper version has no folders to compare: only the version is reported.
    assert.deepEqual(classifyHelperStatus({ ...run, helper_version: P.HELPER_VERSION - 1, setup_backup_root: null }, server).problems.length, 1);
});

test('readiness: a sysadmin login still needs the helper procedures, but no grants', () => {
    const sa = { ...ready, is_sysadmin: 1, can_execute: 0, view_server_state: 0, read_msdb: 0, login_name: 'sa' };
    assert.equal(classifyHelperStatus(sa).ready, true);
    assert.equal(classifyHelperStatus({ ...sa, helper_version: null }).ready, false);
});

test('the setup script: its version matches, and only take_backup may touch system databases', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../sql/mostly-on-helpers.sql', import.meta.url), 'utf8');
    const version = /CREATE FUNCTION mostly_on\.helper_version\(\)[\s\S]*?RETURN (\d+);/.exec(sql);
    assert.equal(Number(version?.[1]), P.HELPER_VERSION);
    assert.match(sql, new RegExp(`helper procedures, version ${P.HELPER_VERSION}\\.`), 'the header says the same version');
    // check_database refuses system databases unless @backup=1, which only take_backup passes.
    const calls = [...sql.matchAll(/EXEC mostly_on\.check_database ([^;]*);/g)].map((m) => m[1]);
    assert.ok(calls.length >= 6);
    assert.equal(calls.filter((c) => /@backup=1/.test(c)).length, 1);
    const takeBackup = /CREATE PROCEDURE mostly_on\.take_backup[\s\S]*?\nGO/.exec(sql)[0];
    assert.match(takeBackup, /check_database @db=@db, @backup=1;/);
    assert.match(takeBackup, /DB_ID\(@db\)=1 AND @type!='FULL'/, 'master: FULL only');
});
