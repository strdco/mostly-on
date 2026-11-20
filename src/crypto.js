// Password hashing (scrypt), credential encryption (AES-256-GCM) and tokens.
// All built on node:crypto, no external dependencies.
import crypto from 'node:crypto';

// Format: scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url>
// ':' instead of '$' so the value survives docker compose variable interpolation.
const SCRYPT_DEFAULTS = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, { N, r, p, keylen }) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
            err ? reject(err) : resolve(key),
        );
    });
}

export async function hashPassword(password, opts = SCRYPT_DEFAULTS) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, opts);
    return ['scrypt', opts.N, opts.r, opts.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifyPassword(password, encoded) {
    const parts = String(encoded).split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64url');
    const opts = { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length };
    if (!Number.isInteger(opts.N) || !Number.isInteger(opts.r) || !Number.isInteger(opts.p) || expected.length < 16) {
        return false;
    }
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64url'), opts);
    return crypto.timingSafeEqual(actual, expected);
}

// Format: v1:<iv b64url>:<tag b64url>:<ciphertext b64url>
export function encrypt(plaintext, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(encoded, key) {
    const [v, ivB64, tagB64, ctB64] = String(encoded).split(':');
    if (v !== 'v1') throw new Error('Unknown ciphertext format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
