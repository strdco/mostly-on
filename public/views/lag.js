// When is a secondary "behind"? Shared by the dashboard and the alert rules
// (src/notify/alerts.js), so colours and notifications always agree.
//
// A secondary's data is naturally up to one log backup interval old: it only
// gets newer when the next log backup has been restored. So the lag threshold
// (alerts.lag_threshold_minutes) counts on top of the database's own LOG
// interval: with logs every 15 minutes and a threshold of 10, it alerts once
// the newest restored data is older than 25 minutes, and turns amber at 20.
// A secondary kept behind on purpose (restore delay) adds its delay on top.

/** Minutes between LOG backups per the schedule, or 0 when it is off. */
export function logIntervalMinutes(logSchedule) {
    if (!logSchedule?.enabled) return 0;
    if (logSchedule.kind === 'interval') return logSchedule.interval_minutes || 0;
    if (logSchedule.kind === 'daily') return 24 * 60;
    if (logSchedule.kind === 'weekly') return 7 * 24 * 60;
    return 0;
}

/**
 * Lag limits for one secondary, in seconds:
 *   warn   amber (half the threshold on top of the LOG interval and the delay)
 *   alert  red, and an alert (the whole threshold on top of them)
 * delayMinutes: the secondary's restore delay (0 for an ordinary secondary).
 */
export function lagLimits(logSchedule, thresholdMinutes, delayMinutes = 0) {
    const base = logIntervalMinutes(logSchedule) + (delayMinutes || 0);
    return {
        logMinutes: logIntervalMinutes(logSchedule),
        delayMinutes: delayMinutes || 0,
        thresholdMinutes,
        warn: Math.round((base + thresholdMinutes / 2) * 60),
        alert: Math.round((base + thresholdMinutes) * 60),
    };
}

/** A restore delay in words: "12 h", "90 min" becomes "1 h 30 min". */
export function delayText(minutes) {
    if (minutes < 60) return `${minutes} min`;
    return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

/** Whether a secondary's restores are paused right now (a past time means: catching up). */
export function restoresPaused(rep, now = Date.now()) {
    const until = Date.parse(rep?.restores_paused_until ?? '');
    return Number.isFinite(until) && until > now;
}
