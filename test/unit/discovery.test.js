// A backup set described as Mostly-On's ("mostly-on op:N") only counts as
// Mostly-On's own if that operation really took it (ownBackupClaim in
// src/engine/discovery.js); anything else is a foreign backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import * as ops from '../../src/store/repos/operations.js';
import { setEngineConfig } from '../../src/engine/context.js';
import { ownBackupClaim } from '../../src/engine/discovery.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');
setEngineConfig({ backupRoot: '/backup' });

function setup() {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const s1 = servers.create(servers.validate({ name: 'sql1', host: 'sql1', username: 'u', password: 'p', sql_backup_root: '/var/opt/mssql/backup' }), key);
    const sales = databases.manage({ name: 'Sales', familyGuid: null, primaryServerId: s1.id });
    const crm = databases.manage({ name: 'Crm', familyGuid: null, primaryServerId: s1.id });
    const rel = 'Sales/LOG/Sales_LOG_20261122_100000_sql1.trn';
    const backup = ops.create({ type: 'backup', databaseId: sales.id, serverId: s1.id, status: 'failed', ctx: { relPath: rel } });
    return { s1, sales, crm, rel, backup };
}

const set = (description, device, type = 'LOG') => ({ description, devices: [device], type, backup_set_uuid: crypto.randomUUID() });

test('a backup its own operation recorded is Mostly-On’s', () => {
    const { s1, sales, rel, backup } = setup();
    const claim = ownBackupClaim(sales, s1, set(`mostly-on op:${backup.id}`, `/var/opt/mssql/backup/${rel}`));
    assert.equal(claim?.op.id, backup.id);
    assert.equal(claim.relPath, rel);
});

test('a tail-log backup of a failover is Mostly-On’s', () => {
    const { s1, sales } = setup();
    const tail = 'Sales/LOG/Sales_LOG_20261122_110000_sql1.trn';
    const fo = ops.create({ type: 'planned_failover', databaseId: sales.id, serverId: s1.id, ctx: { tailRelPath: tail } });
    assert.ok(ownBackupClaim(sales, s1, set(`mostly-on op:${fo.id}`, `/var/opt/mssql/backup/${tail}`)));
});

test('only claiming to be Mostly-On’s is not enough', () => {
    const { s1, sales, crm, rel, backup } = setup();
    const device = `/var/opt/mssql/backup/${rel}`;
    // Another file than the one the operation recorded, even in the right folder.
    assert.equal(ownBackupClaim(sales, s1, set(`mostly-on op:${backup.id}`, '/var/opt/mssql/backup/Sales/LOG/other.trn')), null);
    // An operation of another database, or one that does not exist.
    assert.equal(ownBackupClaim(crm, s1, set(`mostly-on op:${backup.id}`, device)), null);
    assert.equal(ownBackupClaim(sales, s1, set('mostly-on op:999', device)), null);
    // Outside the shared backup folder, more than one device, or no claim at all.
    assert.equal(ownBackupClaim(sales, s1, set(`mostly-on op:${backup.id}`, `/tmp/${rel}`)), null);
    assert.equal(ownBackupClaim(sales, s1, { ...set(`mostly-on op:${backup.id}`, device), devices: [device, device] }), null);
    assert.equal(ownBackupClaim(sales, s1, set(`nightly mostly-on op:${backup.id}`, device)), null);
    assert.equal(ownBackupClaim(sales, s1, set(`mostly-on op:${backup.id}0`, device)), null);
});
