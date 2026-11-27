// Which edits of a registered server need its password again
// (store/repos/servers.js changedConnectionSettings), and what a health check
// records about a server (recordHealth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import { validate, changedConnectionSettings, create, get, recordHealth } from '../../src/store/repos/servers.js';

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

test("a health check records the server's default backup folder, and leaves the shared backup folder alone", () => {
    openDb(':memory:');
    try {
        const s = create(validate({ name: 'sql1', host: 'sql1', username: 'u', password: 'p', sql_backup_root: '/mnt/shared' }), crypto.randomBytes(32));
        const info = { productVersion: '17.0.1000.7', edition: 'Express Edition', engineEdition: 4, defaultDataPath: '/var/opt/mssql/data/', defaultLogPath: '/var/opt/mssql/data/' };
        recordHealth(s.id, { ok: true, ...info, defaultBackupPath: '/var/opt/mssql/backup' });
        assert.equal(get(s.id).default_backup_path, '/var/opt/mssql/backup');
        assert.equal(get(s.id).sql_backup_root, '/mnt/shared');

        // Unreachable: the last known folder stays.
        recordHealth(s.id, { ok: false, error: 'timeout' });
        assert.equal(get(s.id).default_backup_path, '/var/opt/mssql/backup');
        // A server that reports none.
        recordHealth(s.id, { ok: true, ...info, defaultBackupPath: null });
        assert.equal(get(s.id).default_backup_path, null);
    } finally {
        closeDb();
    }
});
