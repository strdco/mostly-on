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
export function openDb(file, { migrationsDir = MIGRATIONS_DIR } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new Database(file);
    try {
        conn.pragma('journal_mode = WAL');
        conn.pragma('synchronous = FULL'); // the catalog is the journal of record; durability over speed
        conn.pragma('foreign_keys = ON');
        conn.pragma('busy_timeout = 5000');
        migrate(conn, { file, dir: migrationsDir });
    } catch (err) {
        conn.close();
        throw err;
    }
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

export class CatalogVersionError extends Error {
    name = 'CatalogVersionError';
}

/**
 * Brings the catalog up to the newest migration in `dir` (NNN_name.sql,
 * applied in order, forward only).
 *
 * - An image older than the catalog refuses to start (CatalogVersionError)
 *   instead of running against a schema it does not know.
 * - Before upgrading an existing file catalog, a copy is written next to it
 *   (<file>.vNNN.bak, NNN = the version it was at). No backup, no upgrade.
 * - Each migration runs in its own transaction with foreign keys OFF, so the
 *   usual SQLite table rebuild (create new, copy, drop old, rename) does not
 *   fire ON DELETE CASCADE. PRAGMA foreign_key_check must come back clean
 *   before the migration commits. Migration files must not contain
 *   BEGIN/COMMIT or PRAGMA foreign_keys themselves.
 */
export function migrate(conn, { file = null, dir = MIGRATIONS_DIR } = {}) {
    conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        applied_at  text NOT NULL
    ) STRICT;`);

    const applied = conn.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    const appliedVersions = new Set(applied.map((r) => r.version));
    const current = applied.at(-1) ?? null;
    const files = fs
        .readdirSync(dir)
        .filter((f) => /^\d{3}_.+\.sql$/.test(f))
        .sort()
        .map((f) => ({ name: f, version: Number.parseInt(f.slice(0, 3), 10) }));
    const known = files.at(-1)?.version ?? 0;

    if (current && current.version > known) {
        throw new CatalogVersionError(
            `The catalog is at version ${current.version} (${current.name}), but this Mostly On image only knows versions up to ${known}. ` +
                'A newer image has upgraded it. Run that image (or a newer one), or restore the catalog from the .bak copy taken before the upgrade.',
        );
    }

    const pending = files.filter((f) => !appliedVersions.has(f.version));
    if (!pending.length) return;
    if (current && file && file !== ':memory:') backupBeforeUpgrade(conn, file, current.version);

    for (const f of pending) {
        const sqlText = fs.readFileSync(path.join(dir, f.name), 'utf8');
        conn.pragma('foreign_keys = OFF'); // a no-op inside a transaction, so it is set out here
        try {
            conn.transaction(() => {
                conn.exec(sqlText);
                const broken = conn.pragma('foreign_key_check');
                if (broken.length) {
                    const sample = broken.slice(0, 5).map((b) => `${b.table} row ${b.rowid} -> ${b.parent}`).join(', ');
                    throw new Error(`Migration ${f.name} leaves ${broken.length} broken foreign key reference(s): ${sample}`);
                }
                conn.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(f.version, f.name, nowIso());
            })();
        } finally {
            conn.pragma('foreign_keys = ON');
        }
        log.info('Applied catalog migration', { migration: f.name });
    }
}

/** A consistent copy of the catalog, taken before any migration touches it. */
function backupBeforeUpgrade(conn, file, version) {
    let dest = `${file}.v${String(version).padStart(3, '0')}.bak`;
    if (fs.existsSync(dest)) dest = `${dest.slice(0, -4)}-${nowIso().replace(/[:.]/g, '')}.bak`;
    conn.prepare('VACUUM INTO ?').run(dest);
    log.info('Backed up the catalog before upgrading it', { backup: dest, fromVersion: version });
    return dest;
}

/** Runs fn inside a transaction (synchronous; better-sqlite3 semantics). */
export function tx(fn) {
    return getDb().transaction(fn)();
}
