// Catalog migration runner (store/db.js): upgrade, backup, rollback,
// downgrade refusal, and table rebuilds that must not cascade.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, closeDb, CatalogVersionError } from '../../src/store/db.js';

const V1 = `
CREATE TABLE parents (id integer PRIMARY KEY, name text NOT NULL) STRICT;
CREATE TABLE children (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES parents (id) ON DELETE CASCADE, label text NOT NULL) STRICT;
`;
// The SQLite table rebuild: add a CHECK constraint to parents.
const V2_REBUILD = `
CREATE TABLE parents_new (id integer PRIMARY KEY, name text NOT NULL CHECK (length(name)>0)) STRICT;
INSERT INTO parents_new (id, name) SELECT id, name FROM parents;
DROP TABLE parents;
ALTER TABLE parents_new RENAME TO parents;
`;

const dirs = [];
function scratch(migrations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mostly-on-mig-'));
    dirs.push(root);
    const dir = path.join(root, 'migrations');
    fs.mkdirSync(dir);
    write(dir, migrations);
    return { dir, file: path.join(root, 'data', 'catalog.db'), root };
}
function write(dir, migrations) {
    for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, name), sql);
}
const versions = (conn) => conn.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all();

afterEach(() => {
    closeDb();
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('the real migrations apply to a fresh catalog, and reopening is a no-op', () => {
    const { root } = scratch({});
    const file = path.join(root, 'data', 'real.db');
    const conn = openDb(file);
    const max = versions(conn).at(-1);
    assert.ok(max >= 1);
    closeDb();
    const again = openDb(file);
    assert.equal(versions(again).at(-1), max);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.bak')), [], 'no backup for a fresh catalog or a no-op open');
});

test('an existing catalog is backed up, then upgraded', () => {
    const s = scratch({ '001_init.sql': V1 });
    let conn = openDb(s.file, { migrationsDir: s.dir });
    conn.prepare("INSERT INTO parents (id, name) VALUES (1, 'a')").run();
    closeDb();

    write(s.dir, { '002_extra.sql': 'ALTER TABLE parents ADD COLUMN note text NULL;' });
    conn = openDb(s.file, { migrationsDir: s.dir });
    assert.deepEqual(versions(conn), [1, 2]);
    assert.equal(conn.prepare('SELECT name FROM parents WHERE id=1').pluck().get(), 'a');

    const bak = `${s.file}.v001.bak`;
    assert.ok(fs.existsSync(bak), 'backup written next to the catalog');
    const old = new Database(bak, { readonly: true });
    assert.deepEqual(versions(old), [1], 'the backup is the pre-upgrade catalog');
    assert.equal(old.prepare('SELECT name FROM parents WHERE id=1').pluck().get(), 'a');
    old.close();
});

test('a second upgrade from the same version does not overwrite the first backup', () => {
    const s = scratch({ '001_init.sql': V1 });
    openDb(s.file, { migrationsDir: s.dir });
    closeDb();
    fs.writeFileSync(`${s.file}.v001.bak`, 'older backup');
    write(s.dir, { '002_extra.sql': 'ALTER TABLE parents ADD COLUMN note text NULL;' });
    openDb(s.file, { migrationsDir: s.dir });
    const baks = fs.readdirSync(path.dirname(s.file)).filter((f) => f.endsWith('.bak'));
    assert.equal(baks.length, 2);
    assert.equal(fs.readFileSync(`${s.file}.v001.bak`, 'utf8'), 'older backup');
});

test('a failing migration rolls back completely and stops the start', () => {
    const s = scratch({ '001_init.sql': V1 });
    openDb(s.file, { migrationsDir: s.dir });
    closeDb();
    write(s.dir, { '002_broken.sql': 'CREATE TABLE half_done (id integer PRIMARY KEY) STRICT;\nINSERT INTO no_such_table VALUES (1);' });
    assert.throws(() => openDb(s.file, { migrationsDir: s.dir }), /no such table/);

    const conn = new Database(s.file);
    assert.deepEqual(versions(conn), [1]);
    assert.equal(conn.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='half_done'").pluck().get(), 0);
    conn.close();
});

test('an older image refuses a catalog upgraded by a newer one', () => {
    const s = scratch({ '001_init.sql': V1, '002_extra.sql': 'ALTER TABLE parents ADD COLUMN note text NULL;' });
    openDb(s.file, { migrationsDir: s.dir });
    closeDb();
    fs.rmSync(path.join(s.dir, '002_extra.sql')); // the older image does not have it
    assert.throws(
        () => openDb(s.file, { migrationsDir: s.dir }),
        (err) => err instanceof CatalogVersionError && /version 2 \(002_extra\.sql\).*only knows versions up to 1/.test(err.message),
    );
});

test('a table rebuild keeps child rows (no ON DELETE CASCADE), and foreign keys work afterwards', () => {
    const s = scratch({ '001_init.sql': V1 });
    let conn = openDb(s.file, { migrationsDir: s.dir });
    conn.prepare("INSERT INTO parents (id, name) VALUES (1, 'a'), (2, 'b')").run();
    conn.prepare("INSERT INTO children (parent_id, label) VALUES (1, 'x'), (1, 'y'), (2, 'z')").run();
    closeDb();

    write(s.dir, { '002_rebuild.sql': V2_REBUILD });
    conn = openDb(s.file, { migrationsDir: s.dir });
    assert.equal(conn.prepare('SELECT COUNT(*) FROM children').pluck().get(), 3, 'children survived the DROP TABLE');
    assert.equal(conn.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on');
    assert.throws(() => conn.prepare("INSERT INTO parents (id, name) VALUES (3, '')").run(), /CHECK constraint/);
    conn.prepare('DELETE FROM parents WHERE id=1').run();
    assert.equal(conn.prepare('SELECT COUNT(*) FROM children').pluck().get(), 1, 'the cascade still works on the rebuilt table');
});

test('a migration that leaves broken references is rolled back', () => {
    const s = scratch({ '001_init.sql': V1 });
    let conn = openDb(s.file, { migrationsDir: s.dir });
    conn.prepare("INSERT INTO parents (id, name) VALUES (1, 'a')").run();
    conn.prepare("INSERT INTO children (parent_id, label) VALUES (1, 'x')").run();
    closeDb();

    // Forgets to copy the rows into the rebuilt table.
    write(s.dir, { '002_bad_rebuild.sql': V2_REBUILD.replace(/INSERT INTO parents_new[^;]+;/, '') });
    assert.throws(() => openDb(s.file, { migrationsDir: s.dir }), /002_bad_rebuild\.sql leaves 1 broken foreign key reference/);

    conn = new Database(s.file);
    assert.deepEqual(versions(conn), [1]);
    assert.equal(conn.prepare('SELECT COUNT(*) FROM parents').pluck().get(), 1);
    conn.close();
});

test('010: the databases table loses its UNIQUE name, and every row that refers to it survives', () => {
    const real = path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/store/migrations');
    const all = fs.readdirSync(real).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const upTo = (n) => Object.fromEntries(all.filter((f) => Number(f.slice(0, 3)) <= n).map((f) => [f, fs.readFileSync(path.join(real, f), 'utf8')]));
    const s = scratch(upTo(9));
    let conn = openDb(s.file, { migrationsDir: s.dir });
    const t = '2026-01-01T00:00:00Z';
    conn.exec(`
        INSERT INTO servers (id, name, host, username, password_enc, sql_backup_root, created_at, updated_at) VALUES (1, 'sql1', 'h', 'u', 'p', '/b', '${t}', '${t}'), (2, 'sql2', 'h', 'u', 'p', '/b', '${t}', '${t}');
        INSERT INTO databases (id, name, status, created_at, updated_at, owner_name, retention_full_days) VALUES (7, 'Sales', 'managed', '${t}', '${t}', 'app', 30), (8, 'Old', 'unmanaged', '${t}', '${t}', NULL, NULL);
        INSERT INTO database_replicas (database_id, server_id, role, updated_at, restore_delay_minutes) VALUES (7, 1, 'primary', '${t}', 0), (7, 2, 'secondary', '${t}', 60);
        INSERT INTO forks (database_id, fork_guid, created_at) VALUES (7, 'f', '${t}');
        INSERT INTO backup_files (id, database_id, server_id, type, rel_path, created_at) VALUES (1, 7, 1, 'FULL', 'Sales/FULL/a.bak', '${t}');
        INSERT INTO restores (backup_file_id, database_id, server_id, started_at) VALUES (1, 7, 2, '${t}');
        INSERT INTO operations (id, type, database_id, status, created_at, updated_at) VALUES (1, 'backup', 7, 'succeeded', '${t}', '${t}');
        INSERT INTO schedules (database_id, backup_type, kind, interval_minutes) VALUES (7, 'LOG', 'interval', 5);
        INSERT INTO foreign_backups (backup_set_uuid, database_id, server_id, type, detected_at) VALUES ('u', 7, 1, 'FULL', '${t}');
    `);
    const counts = () => Object.fromEntries(['databases', 'database_replicas', 'forks', 'backup_files', 'restores', 'operations', 'schedules', 'foreign_backups'].map((tb) => [tb, conn.prepare(`SELECT COUNT(*) FROM ${tb}`).pluck().get()]));
    const before = counts();
    closeDb();

    write(s.dir, upTo(10));
    conn = openDb(s.file, { migrationsDir: s.dir });
    assert.deepEqual(counts(), before, 'every row kept');
    assert.deepEqual(conn.prepare('SELECT id, name, status, owner_name, retention_full_days, backup_only_server_id FROM databases WHERE id=7').get(), {
        id: 7, name: 'Sales', status: 'managed', owner_name: 'app', retention_full_days: 30, backup_only_server_id: null,
    });
    assert.deepEqual(conn.pragma('foreign_key_check'), []);

    // Names: unique among log-shipped databases, and per server among backups-only ones.
    const add = (id, name, server) => conn.prepare(`INSERT INTO databases (id, name, created_at, updated_at, backup_only_server_id) VALUES (?, ?, '${t}', '${t}', ?)`).run(id, name, server);
    assert.throws(() => add(20, 'Sales', null), /UNIQUE/);
    add(21, 'master', 1);
    add(22, 'master', 2);
    assert.throws(() => add(23, 'master', 1), /UNIQUE/);
    add(24, 'Sales', 1); // a backups-only database may share a log-shipped database's name
    assert.throws(() => add(25, 'x', 99), /FOREIGN KEY/);

    // The cascade and SET NULL still work on the rebuilt table.
    conn.prepare('DELETE FROM databases WHERE id=7').run();
    const after = counts();
    for (const tb of ['database_replicas', 'forks', 'backup_files', 'restores', 'schedules', 'foreign_backups']) assert.equal(after[tb], 0, tb);
    assert.equal(conn.prepare('SELECT database_id FROM operations WHERE id=1').pluck().get(), null);
});

test('011: databases stopped before automatic management count as stopped by a person', () => {
    const real = path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/store/migrations');
    const all = fs.readdirSync(real).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const upTo = (n) => Object.fromEntries(all.filter((f) => Number(f.slice(0, 3)) <= n).map((f) => [f, fs.readFileSync(path.join(real, f), 'utf8')]));
    const s = scratch(upTo(10));
    let conn = openDb(s.file, { migrationsDir: s.dir });
    const t = '2026-01-01T00:00:00Z';
    conn.exec(`
        INSERT INTO servers (id, name, host, username, password_enc, sql_backup_root, created_at, updated_at) VALUES (1, 'sql1', 'h', 'u', 'p', '/b', '${t}', '${t}');
        INSERT INTO databases (id, name, status, created_at, updated_at) VALUES (7, 'Sales', 'managed', '${t}', '${t}'), (8, 'Old', 'unmanaged', '${t}', '${t}');
    `);
    closeDb();

    write(s.dir, upTo(11));
    conn = openDb(s.file, { migrationsDir: s.dir });
    assert.deepEqual(conn.prepare('SELECT id, stopped_by, auto_seed FROM databases ORDER BY id').all(), [
        { id: 7, stopped_by: null, auto_seed: 0 },
        { id: 8, stopped_by: 'person', auto_seed: 0 },
    ]);
    assert.deepEqual(conn.prepare('SELECT auto_manage, ship_to_server_id FROM servers').get(), { auto_manage: 0, ship_to_server_id: null });
    assert.throws(() => conn.prepare("UPDATE databases SET stopped_by='nobody' WHERE id=7").run(), /CHECK/);
});

test('013: schedules follow the defaults, except ones edited on the database page since it was last managed', () => {
    const real = path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/store/migrations');
    const all = fs.readdirSync(real).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const upTo = (n) => Object.fromEntries(all.filter((f) => Number(f.slice(0, 3)) <= n).map((f) => [f, fs.readFileSync(path.join(real, f), 'utf8')]));
    const s = scratch(upTo(12));
    let conn = openDb(s.file, { migrationsDir: s.dir });
    const t = '2026-01-01T00:00:00Z';
    const ev = (db, category, message) => `INSERT INTO events (ts, level, category, database_id, message) VALUES ('${t}', 'info', '${category}', ${db}, '${message}');`;
    conn.exec(`
        INSERT INTO databases (id, name, status, created_at, updated_at) VALUES (1, 'Untouched', 'managed', '${t}', '${t}'), (2, 'Edited', 'managed', '${t}', '${t}'), (3, 'Remanaged', 'managed', '${t}', '${t}');
        INSERT INTO schedules (database_id, backup_type, enabled, kind, interval_minutes, at_time, weekday) VALUES
            (1, 'FULL', 1, 'weekly', NULL, '01:00', 0), (1, 'DIFF', 1, 'daily', NULL, '01:30', NULL), (1, 'LOG', 1, 'interval', 5, NULL, NULL),
            (2, 'FULL', 0, 'weekly', NULL, '01:00', 0), (2, 'DIFF', 1, 'daily', NULL, '03:00', NULL), (2, 'LOG', 1, 'interval', 5, NULL, NULL),
            (3, 'DIFF', 1, 'daily', NULL, '01:30', NULL);
        ${ev(1, 'database', 'Started managing Untouched with primary sql1')}
        ${ev(2, 'database', 'Started managing Edited with primary sql1')}
        ${ev(2, 'schedule', 'DIFF schedule of Edited changed')}
        ${ev(3, 'schedule', 'DIFF schedule of Remanaged changed')}
        ${ev(3, 'database', 'Started managing Remanaged with primary sql1')}
    `);
    closeDb();

    write(s.dir, upTo(13));
    conn = openDb(s.file, { migrationsDir: s.dir });
    const rows = conn.prepare('SELECT database_id, backup_type, follows_default FROM schedules ORDER BY database_id, backup_type').all();
    assert.deepEqual(rows.map((r) => `${r.database_id} ${r.backup_type} ${r.follows_default}`), [
        '1 DIFF 1',
        '1 FULL 1',
        '1 LOG 1',
        '2 DIFF 0', // edited after it was managed
        '2 FULL 0', // switched off: FULL and LOG defaults are always on
        '2 LOG 1',
        '3 DIFF 1', // edited, but managed again since (which reset it to the default)
    ]);
});
