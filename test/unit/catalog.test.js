import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { openDb, closeDb, getDb, migrate } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as settings from '../../src/store/repos/settings.js';
import * as databases from '../../src/store/repos/databases.js';
import * as ops from '../../src/store/repos/operations.js';
import { removeBlocker } from '../../src/http/routes/servers.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');

test('migrations create the schema and are idempotent', () => {
    openDb(':memory:');
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
    for (const t of ['servers', 'databases', 'database_replicas', 'backup_files', 'restores', 'operations', 'events', 'schedules', 'settings', 'notification_state', 'forks', 'sessions']) {
        assert.ok(tables.includes(t), `missing table ${t}`);
    }
    migrate(getDb()); // second run is a no-op
    const files = fs.readdirSync(new URL('../../src/store/migrations/', import.meta.url)).filter((f) => /^\d{3}_.+\.sql$/.test(f));
    assert.equal(getDb().prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), files.length);
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

test('a database with other copies cannot stop being managed until they are removed', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const a = servers.create(servers.validate({ name: 'a', host: 'a', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const b = servers.create(servers.validate({ name: 'b', host: 'b', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const db = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: a.id });
    databases.addSecondary({ databaseId: db.id, serverId: b.id, restoreMode: 'norecovery' });
    assert.match(databases.unmanageBlocker(db.id), /Remove its secondaries first \(b:/);
    assert.throws(() => databases.unmanage(db.id), /secondaries first/);
    getDb().prepare("UPDATE database_replicas SET role='diverged' WHERE server_id=?").run(b.id);
    assert.throws(() => databases.unmanage(db.id), /secondaries first/, 'an out-of-sync copy counts too');
    databases.removeReplica(db.id, b.id);
    assert.equal(databases.unmanageBlocker(db.id), null);
    databases.unmanage(db.id);
    assert.equal(databases.get(db.id).status, 'unmanaged');
    closeDb();
});

test('Remove: a server without history is deleted; one with history is hidden but kept, and comes back when registered again', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const typo = mk('sq1');
    assert.equal(servers.removeOrRetire(typo.id), 'deleted');
    assert.equal(servers.get(typo.id), undefined);

    const old = mk('old');
    ops.create({ type: 'backup', serverId: old.id, status: 'succeeded' }); // history refers to it
    assert.equal(servers.removeOrRetire(old.id), 'removed');
    assert.ok(servers.get(old.id).removed_at, 'the row stays, so its backup files are still found');
    assert.equal(servers.get(old.id).enabled, false);
    assert.deepEqual(servers.list().map((s) => s.name), [], 'hidden from every list');

    const back = servers.revive(old.id, servers.validate({ name: 'old', host: 'newhost', username: 'u2', password: 'p2', sql_backup_root: '/b2' }), key);
    assert.equal(back.id, old.id, 'same record, history attached');
    assert.equal(back.removed_at, null);
    assert.equal(back.enabled, true);
    assert.equal(back.host, 'newhost');
    assert.equal(servers.getWithSecret(old.id, key).password, 'p2');
    closeDb();
});

test('Remove is blocked while the server holds a copy or an unfinished operation involves it', () => {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const a = servers.create(servers.validate({ name: 'a', host: 'a', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const b = servers.create(servers.validate({ name: 'b', host: 'b', username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const db = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: a.id });
    assert.match(removeBlocker(a.id), /still holds 1 primary copy of managed databases/);
    for (const name of ['Big', 'Crm']) databases.manage({ name, familyGuid: null, primaryServerId: a.id });
    databases.addSecondary({ databaseId: db.id, serverId: b.id, restoreMode: 'norecovery' });
    assert.match(removeBlocker(a.id), /still holds 3 primary copies of/, 'counts, never a list of names');
    assert.match(removeBlocker(b.id), /still holds 1 secondary copy of/);
    databases.removeReplica(db.id, b.id);
    assert.equal(removeBlocker(b.id), null);
    const op = ops.create({ type: 'planned_failover', databaseId: db.id, serverId: a.id, params: { targetServerId: a.id, oldPrimaryServerId: b.id }, status: 'failed' });
    assert.match(removeBlocker(b.id), new RegExp(`Operation #${op.id} involving it stopped`));
    ops.save(op.id, { status: 'resolved' });
    assert.equal(removeBlocker(b.id), null);
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
