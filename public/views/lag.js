// When is a secondary "behind"? Shared by the dashboard and the alert rules
// (src/notify/alerts.js), so colours and notifications always agree.
//
// A secondary's data is naturally up to one log backup interval old: it only
// gets newer when the next log backup has been restored. So the lag threshold
// (alerts.lag_threshold_minutes) counts on top of the database's own LOG
// interval: with logs every 15 minutes and a threshold of 10, it alerts once
// the newest restored data is older than 25 minutes, and turns amber at 20.

/** Minutes between LOG backups per the schedule, or 0 when it is off. */
export function logIntervalMinutes(logSchedule) {
    if (!logSchedule?.enabled) return 0;
    if (logSchedule.kind === 'interval') return logSchedule.interval_minutes || 0;
    if (logSchedule.kind === 'daily') return 24 * 60;
    if (logSchedule.kind === 'weekly') return 7 * 24 * 60;
    return 0;
}

/**
 * Lag limits for one database, in seconds:
 *   warn   amber (half the threshold on top of the LOG interval)
 *   alert  red, and an alert (the whole threshold on top of it)
 */
export function lagLimits(logSchedule, thresholdMinutes) {
    const base = logIntervalMinutes(logSchedule);
    return {
        logMinutes: base,
        thresholdMinutes,
        warn: Math.round((base + thresholdMinutes / 2) * 60),
        alert: Math.round((base + thresholdMinutes) * 60),
    };
}
