// "Fail over databases" from a server: which servers are offered as targets,
// and which databases move to the chosen one (src/engine/ops/switchover-all.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, closeDb } from '../../src/store/db.js';
import * as servers from '../../src/store/repos/servers.js';
import * as databases from '../../src/store/repos/databases.js';
import { switchoverTargets, switchoverPlan } from '../../src/engine/ops/switchover-all.js';
import { setLogLevel } from '../../src/log.js';

setLogLevel('error');

function setup() {
    openDb(':memory:');
    const key = crypto.randomBytes(32);
    const mk = (name) => servers.create(servers.validate({ name, host: name, username: 'u', password: 'p', sql_backup_root: '/b' }), key);
    const [s1, s2, s3, s4] = ['sql1', 'sql2', 'sql3', 'sql4'].map(mk);
    const db = (name, secondaries) => {
        const d = databases.manage({ name, familyGuid: null, primaryServerId: s1.id });
        for (const [server, chain] of secondaries) {
            databases.addSecondary({ databaseId: d.id, serverId: server.id, restoreMode: 'norecovery' });
            databases.updateReplica(d.id, server.id, { chain_state: chain });
        }
        return d;
    };
    db('Sales', [[s2, 'ok'], [s3, 'ok']]);
    db('Crm', [[s2, 'ok']]);
    db('Hr', [[s2, 'broken'], [s3, 'ok']]);
    db('Wiki', []);
    return { s1, s2, s3, s4 };
}

test('only servers with a working secondary are offered, the one covering most first', () => {
    const { s1 } = setup();
    const t = switchoverTargets(s1.id);
    assert.equal(t.total, 4);
    assert.deepEqual(
        t.targets.map((x) => `${x.name}:${x.covers}`),
        ['sql2:2', 'sql3:2'],
        'sql4 holds no copy and is not offered; a stopped secondary does not count',
    );
    closeDb();
});

test('the plan moves what can move and says why the rest stays', () => {
    const { s1, s2 } = setup();
    const { items } = switchoverPlan(s1.id, s2.id);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(byName.Sales.moves, true);
    assert.equal(byName.Crm.moves, true);
    assert.equal(byName.Hr.moves, false);
    assert.match(byName.Hr.problem, /shipping to sql2 has stopped/);
    assert.equal(byName.Wiki.moves, false);
    assert.match(byName.Wiki.problem, /no copy on sql2/);
    closeDb();
});
