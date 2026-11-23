// Backups-only databases are never shipped, failed over or restored, and
// never count as something "Fail over databases" could move.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import { seedPreflight } from '../../src/engine/ops/seed.js';
import { failoverPreview } from '../../src/engine/ops/failover.js';
import { restoreRange, startPointInTime } from '../../src/engine/ops/pitr.js';
import { switchoverTargets, switchoverPlan } from '../../src/engine/ops/switchover-all.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
beforeEach(() => closeDb());

function setup() {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const [s1, s2] = [mk('sql1'), mk('sql2')];
    const master = databases.manage({ name: 'master', familyGuid: null, primaryServerId: s1.id, backupOnly: true, fullOnly: true });
    const util = databases.manage({ name: 'Util', familyGuid: null, primaryServerId: s1.id, backupOnly: true });
    const sales = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: s1.id });
    databases.addSecondary({ databaseId: sales.id, serverId: s2.id, restoreMode: 'norecovery' });
    return { s1, s2, master, util, sales };
}

const status409 = (re) => (err) => err.status === 409 && re.test(err.message);

test('a backups-only database cannot get a secondary', async () => {
    const { s2, master, util } = setup();
    await assert.rejects(seedPreflight(master.id, s2.id), status409(/master on sql1 is a system database: Mostly-On only backs it up/));
    await assert.rejects(seedPreflight(util.id, s2.id), status409(/Util on sql1 is managed as backups only .* switch it to FULL recovery, stop managing it, then manage it again/));
});

test('a secondary never overwrites a database Mostly-On backs up on the target', async () => {
    const { s1, s2 } = setup();
    const crm = databases.manage({ name: 'Crm', familyGuid: null, primaryServerId: s1.id });
    databases.manage({ name: 'Crm', familyGuid: null, primaryServerId: s2.id, backupOnly: true });
    await assert.rejects(seedPreflight(crm.id, s2.id), status409(/sql2 has its own database called Crm, which Mostly-On backs up there/));
});

test('no failover and no restore for a backups-only database', async () => {
    const { s2, util } = setup();
    await assert.rejects(failoverPreview(util.id, s2.id), status409(/only backs up Util on sql1: it has no secondaries/));
    assert.throws(() => restoreRange(util.id), status409(/does not perform managed restores\. Backup files live in Util@sql1 on the backup share/));
    await assert.rejects(startPointInTime(util.id, { mode: 'copy', at: new Date().toISOString(), targetServerId: s2.id, newName: 'X' }), status409(/does not perform managed restores/));
});

test('"Fail over databases" leaves backups-only databases out', () => {
    const { s1, s2 } = setup();
    assert.equal(switchoverTargets(s1.id).total, 1, 'only Sales');
    assert.deepEqual(switchoverPlan(s1.id, s2.id).items.map((i) => i.name), ['Sales']);
});
