// Configuration from environment variables. Everything is validated once at
// startup; the rest of the app imports the frozen `config` object.
import path from 'node:path';

function str(name, def) {
    const v = process.env[name];
    return v === undefined || v === '' ? def : v;
}

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
    const raw = str(name, undefined);
    if (raw === undefined) return def;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw.trim() || n < min || n > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    }
    return n;
}

function bool(name, def) {
    const raw = str(name, undefined);
    if (raw === undefined) return def;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    throw new Error(`${name} must be a boolean (true/false), got "${raw}"`);
}

export function loadConfig({ requireSecrets = true } = {}) {
    const publicUrl = str('PUBLIC_URL', `http://localhost:${str('PORT', '8080')}`).replace(/\/+$/, '');
    let publicOrigin;
    try {
        publicOrigin = new URL(publicUrl).origin;
    } catch {
        throw new Error(`PUBLIC_URL is not a valid URL: "${publicUrl}"`);
    }

    const cfg = {
        port: int('PORT', 8080, { min: 1, max: 65535 }),
        host: str('HOST', '0.0.0.0'),
        dataDir: path.resolve(str('DATA_DIR', './data')),
        backupRoot: path.posix.normalize(str('BACKUP_ROOT', '/backup')).replace(/\/+$/, '') || '/',
        adminUser: str('ADMIN_USER', 'admin'),
        adminPasswordHash: str('ADMIN_PASSWORD_HASH', ''),
        secretKey: str('SECRET_KEY', ''),
        publicUrl,
        publicOrigin,
        cookieSecure: bool('COOKIE_SECURE', publicUrl.startsWith('https:')),
        sessionTtlHours: int('SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 }),
        logLevel: str('LOG_LEVEL', 'info'),
        pushover: {
            appToken: str('PUSHOVER_APP_TOKEN', ''),
            userKey: str('PUSHOVER_USER_KEY', ''),
            apiUrl: str('PUSHOVER_API_URL', 'https://api.pushover.net/1/messages.json'),
        },
    };

    if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) {
        throw new Error(`LOG_LEVEL must be one of debug, info, warn, error`);
    }
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(cfg.adminUser)) {
        throw new Error('ADMIN_USER may only contain letters, digits and _ . @ -');
    }
    if (requireSecrets) {
        if (!cfg.adminPasswordHash) {
            throw new Error('ADMIN_PASSWORD_HASH is required. Generate one with: npm run hash-password');
        }
        if (!cfg.adminPasswordHash.startsWith('scrypt:')) {
            throw new Error('ADMIN_PASSWORD_HASH has an unknown format. Generate one with: npm run hash-password');
        }
        const key = Buffer.from(cfg.secretKey, 'base64');
        if (key.length !== 32) {
            throw new Error('SECRET_KEY must be 32 random bytes, base64-encoded. Generate one with: npm run gen-secret');
        }
        cfg.secretKeyBytes = key;
    }
    return Object.freeze(cfg);
}
