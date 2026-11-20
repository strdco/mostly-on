// Log sequence numbers are numeric(25,0) in SQL Server. They exceed 2^53, so
// they are carried as decimal strings everywhere and compared as BigInt.
// Never convert an LSN to a JS number.
const LSN_RE = /^\d{1,25}$/;

export function isLsn(v) {
    return typeof v === 'string' && LSN_RE.test(v);
}

export function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (!isLsn(v)) throw new TypeError(`Not an LSN string: ${JSON.stringify(v)}`);
    return BigInt(v);
}

/** Normalizes an LSN (drops leading zeros) or returns null for null/undefined. */
export function norm(v) {
    if (v === null || v === undefined) return null;
    return toBig(v).toString();
}

/** -1, 0 or 1. */
export function cmp(a, b) {
    const x = toBig(a);
    const y = toBig(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

export const lt = (a, b) => cmp(a, b) < 0;
export const lte = (a, b) => cmp(a, b) <= 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const gte = (a, b) => cmp(a, b) >= 0;
export const eq = (a, b) => cmp(a, b) === 0;

export function max(...xs) {
    const vals = xs.filter((x) => x !== null && x !== undefined);
    if (!vals.length) return null;
    return vals.reduce((m, x) => (gt(x, m) ? x : m));
}

export function min(...xs) {
    const vals = xs.filter((x) => x !== null && x !== undefined);
    if (!vals.length) return null;
    return vals.reduce((m, x) => (lt(x, m) ? x : m));
}

/** Array sort comparator on a property holding an LSN. */
export function by(prop) {
    return (a, b) => cmp(a[prop], b[prop]);
}
