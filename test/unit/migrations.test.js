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
