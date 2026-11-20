import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb, getDb, migrate } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as settings from '../../src/store/repos/settings.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');

test('migrations create the schema and are idempotent', () => {
    openDb(':memory:');
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
    for (const t of ['servers', 'databases', 'database_replicas', 'backup_files', 'restores', 'operations', 'events', 'schedules', 'settings', 'notification_state', 'forks', 'sessions']) {
        assert.ok(tables.includes(t), `missing table ${t}`);
    }
    migrate(getDb()); // second run is a no-op
    assert.equal(getDb().prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 1);
    closeDb();
});

test('server credentials are stored encrypted', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const v = servers.validate({ name: 'sql1', host: 'sql1', username: 'sa', password: 'P@ssw0rd!', sql_backup_root: '/var/opt/mssql/backup' });
    const s = servers.create(v, key);
    assert.equal(s.password, undefined);
    const raw = getDb().prepare('SELECT password_enc FROM servers WHERE id=?').pluck().get(s.id);
    assert.ok(!raw.includes('P@ssw0rd!'));
    assert.equal(servers.getWithSecret(s.id, key).password, 'P@ssw0rd!');
    closeDb();
});

test('server validation rejects bad input', () => {
    assert.throws(() => servers.validate({ name: 'bad name', host: 'h', username: 'u', password: 'p', sql_backup_root: '/b' }), /name/);
    assert.throws(() => servers.validate({ name: 'ok', host: 'h;drop', username: 'u', password: 'p', sql_backup_root: '/b' }), /host/);
    assert.throws(() => servers.validate({ name: 'ok', host: 'h', username: 'u', password: 'p', sql_backup_root: 'relative' }), /absolute/);
    assert.throws(() => servers.validate({ name: 'ok', host: 'h', username: 'u', password: 'p', sql_backup_root: '/a/../b' }), /absolute/);
    const partial = servers.validate({ port: 1500 }, { partial: true });
    assert.deepEqual(partial, { port: 1500 });
});

test('only one primary per database', () => {
    openDb(':memory:');
    const db = getDb();
    const now = new Date().toISOString();
    const key = crypto.randomBytes(32);
    const a = servers.create(servers.validate({ name: 'a', host: 'a', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const b = servers.create(servers.validate({ name: 'b', host: 'b', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    db.prepare("INSERT INTO databases (id, name, created_at, updated_at) VALUES (1, 'x', ?, ?)").run(now, now);
    db.prepare("INSERT INTO database_replicas (database_id, server_id, role, updated_at) VALUES (1, ?, 'primary', ?)").run(a.id, now);
    assert.throws(() => db.prepare("INSERT INTO database_replicas (database_id, server_id, role, updated_at) VALUES (1, ?, 'primary', ?)").run(b.id, now), /UNIQUE/);
    db.prepare("INSERT INTO database_replicas (database_id, server_id, role, updated_at) VALUES (1, ?, 'secondary', ?)").run(b.id, now);
    closeDb();
});

test('settings have defaults and validate types', () => {
    openDb(':memory:');
    assert.equal(settings.get('alerts.lag_threshold_minutes'), 30);
    settings.set('alerts.lag_threshold_minutes', 45);
    assert.equal(settings.get('alerts.lag_threshold_minutes'), 45);
    assert.throws(() => settings.set('alerts.lag_threshold_minutes', 'x'));
    assert.throws(() => settings.set('nope', 1));
    closeDb();
});
