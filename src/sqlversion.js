// SQL Server version facts the controller depends on.
//
// Supported: SQL Server 2017 (14.x) and newer. The backup/restore mechanics
// cheap-log uses (BACKUP ... WITH CHECKSUM/INIT/NORECOVERY, RESTORE ... WITH
// NORECOVERY/STANDBY/MOVE, msdb backupset/restorehistory, recovery forks) are
// unchanged across this range. T-SQL sent by the controller must therefore
// stay within the 2017 feature set (no IS NOT DISTINCT FROM, GREATEST/LEAST,
// DATETRUNC, etc.).
const GB = 1024 ** 3;

export const MIN_MAJOR = 14;

const NAMES = { 14: '2017', 15: '2019', 16: '2022', 17: '2025' };

export function majorOf(productVersion) {
    const n = Number.parseInt(String(productVersion ?? '').split('.')[0], 10);
    return Number.isFinite(n) ? n : null;
}

export function versionName(major) {
    return NAMES[major] ? `SQL Server ${NAMES[major]}` : `SQL Server ${major}.x`;
}

export function isSupported(major) {
    return Number.isInteger(major) && major >= MIN_MAJOR;
}

/**
 * Express edition data size limit per database (data files only).
 * 10 GB up to 2022, 50 GB from 2025. null for editions without a limit.
 */
export function dataLimitBytes(major, engineEdition) {
    if (engineEdition !== 4) return null; // 4 = Express
    return major >= 17 ? 50 * GB : 10 * GB;
}

/**
 * Can a backup taken on sourceMajor be restored on targetMajor?
 * Restores only go to the same or a newer version, and STANDBY (read-only
 * access) needs the same version, because reading the database on a newer
 * version would mean upgrading it, which ends the restore sequence.
 */
export function restoreCompatibility(sourceMajor, targetMajor) {
    if (!Number.isInteger(sourceMajor) || !Number.isInteger(targetMajor)) {
        return { ok: false, standby: false, reason: 'Unknown version' };
    }
    if (targetMajor < sourceMajor) {
        return { ok: false, standby: false, reason: `${versionName(targetMajor)} cannot restore backups from ${versionName(sourceMajor)}` };
    }
    if (targetMajor > sourceMajor) {
        return {
            ok: true,
            standby: false,
            reason: `${versionName(targetMajor)} can restore from ${versionName(sourceMajor)} with NORECOVERY only, and after a failover to it the database cannot be shipped back to ${versionName(sourceMajor)}`,
        };
    }
    return { ok: true, standby: true, reason: null };
}
