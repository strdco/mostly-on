import { test } from 'node:test';
import assert from 'node:assert/strict';
import { majorOf, isSupported, restoreCompatibility, versionName } from '../../src/sqlversion.js';

test('version parsing and support range', () => {
    assert.equal(majorOf('17.0.1000.7'), 17);
    assert.equal(majorOf('14.0.3456.2'), 14);
    assert.equal(majorOf(null), null);
    assert.equal(isSupported(14), false);
    assert.equal(isSupported(15), true);
    assert.equal(isSupported(17), true);
    assert.equal(versionName(15), 'SQL Server 2019');
    assert.equal(versionName(18), 'SQL Server 18.x');
});

test('restore compatibility across versions', () => {
    assert.deepEqual(restoreCompatibility(16, 16), { ok: true, standby: true, reason: null });
    const up = restoreCompatibility(15, 17);
    assert.equal(up.ok, true);
    assert.equal(up.standby, false);
    assert.equal(restoreCompatibility(17, 16).ok, false);
});
