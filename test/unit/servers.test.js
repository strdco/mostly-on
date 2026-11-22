// Which edits of a registered server need its password again
// (store/repos/servers.js changedConnectionSettings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, changedConnectionSettings } from '../../src/store/repos/servers.js';

const saved = {
    id: 1,
    name: 'sql1',
    host: 'sql1.example.local',
    port: 1433,
    instance_name: null,
    username: 'mostly_on',
    encrypt: true,
    trust_server_cert: false,
    sql_backup_root: '/var/opt/mssql/backup',
};

// What the edit form sends when nothing was changed: every field, password empty.
const form = {
    name: 'sql1',
    host: 'sql1.example.local',
    port: 1433,
    instance_name: '',
    username: 'mostly_on',
    password: '',
    encrypt: true,
    trust_server_cert: false,
    sql_backup_root: '/var/opt/mssql/backup',
    enabled: true,
};

const edit = (changes) => validate({ ...form, ...changes }, { partial: true });

test('an unchanged form, a rename or a new backup folder keeps the saved password', () => {
    assert.deepEqual(changedConnectionSettings(saved, edit({})), []);
    assert.deepEqual(changedConnectionSettings(saved, edit({ name: 'sql-one', sql_backup_root: '/backup' })), []);
    assert.deepEqual(changedConnectionSettings(saved, edit({ host: 'SQL1.example.local' })), []);
    assert.deepEqual(changedConnectionSettings(saved, validate({ enabled: false }, { partial: true })), []);
});

test('a new destination, login or weaker protection needs the password again', () => {
    assert.deepEqual(changedConnectionSettings(saved, edit({ host: 'attacker.example' })), ['host']);
    assert.deepEqual(changedConnectionSettings(saved, edit({ port: 14330 })), ['port']);
    assert.deepEqual(changedConnectionSettings(saved, edit({ instance_name: 'SQLEXPRESS' })), ['instance name']);
    assert.deepEqual(changedConnectionSettings(saved, edit({ username: 'sa' })), ['SQL login']);
    assert.deepEqual(changedConnectionSettings(saved, edit({ encrypt: false, trust_server_cert: true })), ['encryption', 'certificate trust']);
});
