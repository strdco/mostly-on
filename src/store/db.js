// SQLite catalog: open, configure and migrate.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../log.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

let db = null;

export function nowIso() {
    return new Date().toISOString();
}

/** Opens (and migrates) the catalog. `file` may be ':memory:' for tests. */
export function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = FULL'); // the catalog is the journal of record; durability over speed
    conn.pragma('foreign_keys = ON');
    conn.pragma('busy_timeout = 5000');
    migrate(conn);
    db = conn;
    return conn;
}

export function getDb() {
    if (!db) throw new Error('Catalog not opened');
    return db;
}

export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

export function migrate(conn) {
    conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        applied_at  text NOT NULL
    ) STRICT;`);

    const applied = new Set(conn.prepare('SELECT version FROM schema_migrations').pluck().all());
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}_.+\.sql$/.test(f))
        .sort();

    for (const f of files) {
        const version = Number.parseInt(f.slice(0, 3), 10);
        if (applied.has(version)) continue;
        const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        conn.transaction(() => {
            conn.exec(sqlText);
            conn.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, f, nowIso());
        })();
        log.info('Applied catalog migration', { migration: f });
    }
}

/** Runs fn inside a transaction (synchronous; better-sqlite3 semantics). */
export function tx(fn) {
    return getDb().transaction(fn)();
}
