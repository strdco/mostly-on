// Registered SQL Server instances.
import { getDb, nowIso } from '../db.js';
import { encrypt, decrypt } from '../../crypto.js';
import path from 'node:path';
import { isWindowsPath } from '../../paths.js';

const PUBLIC_COLS = `id, name, host, port, instance_name, username, encrypt, trust_server_cert, sql_backup_root,
    controller_backup_root, standby_root, enabled, last_seen_at, last_error, product_version, edition,
    engine_edition, default_data_path, default_log_path, created_at, updated_at, removed_at`;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function toBool(r) {
    if (!r) return r;
    return { ...r, encrypt: !!r.encrypt, trust_server_cert: !!r.trust_server_cert, enabled: !!r.enabled };
}

/** Registered servers (not removed ones). */
export function list() {
    return getDb().prepare(`SELECT ${PUBLIC_COLS} FROM servers WHERE removed_at IS NULL ORDER BY name`).all().map(toBool);
}

export function get(id) {
    return toBool(getDb().prepare(`SELECT ${PUBLIC_COLS} FROM servers WHERE id=?`).get(id));
}

export function getByName(name) {
    return toBool(getDb().prepare(`SELECT ${PUBLIC_COLS} FROM servers WHERE name=?`).get(name));
}

/** Server row including the decrypted password. Only for building connections. */
export function getWithSecret(id, key) {
    const r = getDb().prepare(`SELECT ${PUBLIC_COLS}, password_enc FROM servers WHERE id=?`).get(id);
    if (!r) return null;
    const { password_enc: enc, ...rest } = r;
    return { ...toBool(rest), password: decrypt(enc, key) };
}

/** Validates user input for create/update. Returns a normalized object or throws. */
export function validate(input, { partial = false } = {}) {
    const out = {};
    const err = (m) => {
        const e = new Error(m);
        e.status = 400;
        throw e;
    };
    const has = (k) => input[k] !== undefined;
    const req = (k) => {
        if (!partial && !has(k)) err(`${k} is required`);
        return has(k);
    };

    if (req('name')) {
        if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) err('name may only contain letters, digits, _ . - (max 64)');
        out.name = input.name;
    }
    if (req('host')) {
        if (typeof input.host !== 'string' || !/^[A-Za-z0-9_.:-]{1,253}$/.test(input.host)) err('host is not a valid host name or address');
        out.host = input.host;
    }
    if (has('port')) {
        const p = Number(input.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) err('port must be 1-65535');
        out.port = p;
    } else if (!partial) out.port = 1433;
    if (has('instance_name')) {
        // Named instance (reached through the SQL Server Browser service); empty = connect to host:port.
        const v = input.instance_name === null ? '' : String(input.instance_name).trim();
        if (v !== '' && !/^[A-Za-z_][A-Za-z0-9_$#@]{0,15}$/.test(v)) err('instance name must be 1-16 letters, digits or _ $ # @, starting with a letter or _');
        out.instance_name = v || null;
    }
    if (req('username')) {
        if (typeof input.username !== 'string' || !input.username || input.username.length > 128) err('username is invalid');
        out.username = input.username;
    }
    if (has('password') && input.password !== '') {
        if (typeof input.password !== 'string' || input.password.length > 256) err('password is invalid');
        out.password = input.password;
    } else if (!partial) err('password is required');
    for (const k of ['encrypt', 'trust_server_cert', 'enabled']) {
        if (has(k)) out[k] = input[k] ? 1 : 0;
    }
    // windows: the path may also be a Windows one (SQL Server paths); the controller's are always POSIX.
    const absPath = (k, required, { windows }) => {
        if (has(k) && input[k] !== null && input[k] !== '') {
            const v = String(input[k]).trim();
            const ok = v.startsWith('/') || (windows && isWindowsPath(v));
            if (!ok || v.includes('\0') || v.split(/[\\/]/).includes('..') || v.length > 400) {
                err(windows ? `${k} must be an absolute path, such as /var/opt/mssql/backup, D:\\Backup or \\\\fileserver\\backup` : `${k} must be an absolute path, such as /backup`);
            }
            if (isWindowsPath(v)) {
                // One form only (D:\\Backup, \\\\fs\\share), so it matches what SQL Server and the setup script see.
                const n = path.win32.normalize(v);
                out[k] = /^[A-Za-z]:\\$/.test(n) ? n : n.replace(/\\+$/, '');
            } else out[k] = v.replace(/\/+$/, '') || '/';
        } else if (has(k)) {
            if (required) err(`${k} is required`);
            out[k] = null;
        } else if (required && !partial) err(`${k} is required`);
    };
    absPath('sql_backup_root', true, { windows: true });
    absPath('controller_backup_root', false, { windows: false });
    absPath('standby_root', false, { windows: true });
    return out;
}

export function create(v, key) {
    const now = nowIso();
    const info = getDb()
        .prepare(
            `INSERT INTO servers (name, host, port, instance_name, username, password_enc, encrypt, trust_server_cert,
                sql_backup_root, controller_backup_root, standby_root, enabled, created_at, updated_at)
             VALUES (@name, @host, @port, @instance_name, @username, @password_enc, @encrypt, @trust_server_cert,
                @sql_backup_root, @controller_backup_root, @standby_root, @enabled, @now, @now)`,
        )
        .run({
            name: v.name,
            host: v.host,
            port: v.port,
            instance_name: v.instance_name ?? null,
            username: v.username,
            password_enc: encrypt(v.password, key),
            encrypt: v.encrypt ?? 1,
            trust_server_cert: v.trust_server_cert ?? 0,
            sql_backup_root: v.sql_backup_root,
            controller_backup_root: v.controller_backup_root ?? null,
            standby_root: v.standby_root ?? null,
            enabled: v.enabled ?? 1,
            now,
        });
    return get(Number(info.lastInsertRowid));
}

export function update(id, v, key) {
    const cols = [];
    const args = {};
    for (const k of ['name', 'host', 'port', 'instance_name', 'username', 'encrypt', 'trust_server_cert', 'sql_backup_root', 'controller_backup_root', 'standby_root', 'enabled']) {
        if (v[k] !== undefined) {
            cols.push(`${k}=@${k}`);
            args[k] = v[k];
        }
    }
    if (v.password !== undefined) {
        cols.push('password_enc=@password_enc');
        args.password_enc = encrypt(v.password, key);
    }
    if (!cols.length) return get(id);
    cols.push('updated_at=@now');
    args.now = nowIso();
    args.id = id;
    getDb().prepare(`UPDATE servers SET ${cols.join(', ')} WHERE id=@id`).run(args);
    return get(id);
}

export function recordHealth(id, h) {
    const now = nowIso();
    if (h.ok) {
        getDb()
            .prepare(
                `UPDATE servers SET last_seen_at=?, last_error=NULL, product_version=?, edition=?, engine_edition=?,
                    default_data_path=?, default_log_path=? WHERE id=?`,
            )
            .run(now, h.productVersion, h.edition, h.engineEdition, h.defaultDataPath, h.defaultLogPath, id);
    } else {
        getDb().prepare('UPDATE servers SET last_error=? WHERE id=?').run(String(h.error).slice(0, 1000), id);
    }
}

/**
 * "Remove": deletes a server that has no history at all; otherwise keeps its
 * row, marked removed (its backup files are still found through it).
 * Returns 'deleted' or 'removed'.
 */
export function removeOrRetire(id) {
    try {
        getDb().prepare('DELETE FROM servers WHERE id=?').run(id);
        return 'deleted';
    } catch (err) {
        if (!/FOREIGN KEY/.test(err.message)) throw err;
    }
    const now = nowIso();
    getDb().prepare('UPDATE servers SET removed_at=?, enabled=0, updated_at=? WHERE id=?').run(now, now, id);
    getDb().prepare('DELETE FROM discovered_databases WHERE server_id=?').run(id);
    return 'removed';
}

/** Registers a removed server again with new details (same id, so its history stays attached). */
export function revive(id, v, key) {
    getDb().prepare('UPDATE servers SET removed_at=NULL, last_error=NULL WHERE id=?').run(id);
    return update(id, { ...v, enabled: v.enabled ?? 1 }, key);
}

export function replicaCount(id) {
    return getDb().prepare('SELECT COUNT(*) FROM database_replicas WHERE server_id=?').pluck().get(id);
}
