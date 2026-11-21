// When a secondary counts as behind (public/views/lag.js): the threshold is
// measured on top of the database's own LOG interval, so a normal wait for
// the next log backup never turns amber or alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lagLimits, logIntervalMinutes } from '../../public/views/lag.js';

const every = (minutes) => ({ enabled: true, kind: 'interval', interval_minutes: minutes });

test('logs every 15 minutes with a 10-minute threshold: amber after 20, alert after 25', () => {
    const l = lagLimits(every(15), 10);
    assert.equal(l.warn, 20 * 60);
    assert.equal(l.alert, 25 * 60);
    // Just before the next log backup the data is about 15 minutes old: normal, no colour.
    assert.ok(15 * 60 < l.warn);
});

test('the same threshold adapts to each database', () => {
    assert.equal(lagLimits(every(5), 30).alert, 35 * 60);
    assert.equal(lagLimits(every(60), 30).alert, 90 * 60);
    assert.equal(logIntervalMinutes({ enabled: true, kind: 'daily' }), 1440);
});

test('with LOG backups switched off, only the threshold counts', () => {
    assert.equal(logIntervalMinutes({ enabled: false, kind: 'interval', interval_minutes: 5 }), 0);
    assert.equal(lagLimits(undefined, 30).alert, 30 * 60);
});
