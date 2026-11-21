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

test('readiness: a sysadmin login still needs the helper procedures, but no grants', () => {
    const sa = { ...ready, is_sysadmin: 1, can_execute: 0, view_server_state: 0, read_msdb: 0, login_name: 'sa' };
    assert.equal(classifyHelperStatus(sa).ready, true);
    assert.equal(classifyHelperStatus({ ...sa, helper_version: null }).ready, false);
});
