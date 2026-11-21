// The whole brief, end to end, against real SQL Server containers:
//   1. register both servers, manage a new database on sql1, add sql2 as its secondary
//   2. ship a row, fail over to sql2 (tail-log backup), the row is there
//   3. fail back to sql1; a row written on sql2 comes along
//   4. stop sql1, fail over without it: shipped rows survive, the unshipped one is lost
//   5. start sql1: its copy is out of sync; reinitialize it and it ships again
//   6. alerts: one notification per problem, none re-sent after a controller restart
//
// Run: npm run test:integration   (Docker required; takes several minutes)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Api, startStack, stopStack, compose, waitFor, sqlQuery, controllerUp, mockMessages, opSummary, sleep } from './harness.js';

const DB = 'ItShop';
const api = new Api();
let secrets;
let dbId;
const ids = {}; // server name -> id

const q = (server, text, params) => sqlQuery(secrets.saPassword, server, text, params);
const rowCount = async (server, note) =>
    (await q(server, `SELECT COUNT(*) AS n FROM ${DB}.dbo.orders WHERE note=@note;`, { note }))[0].n;
const dbState = async (server) => (await q(server, 'SELECT state_desc FROM sys.databases WHERE name=@name;', { name: DB }))[0]?.state_desc ?? null;
const replica = async (serverName) => (await api.get(`/api/databases/${dbId}`)).replicas.find((r) => r.server_name === serverName);
const primaryName = async () => (await replica('sql1'))?.role === 'primary' ? 'sql1' : 'sql2';

async function insertRow(server, note) {
    await q(server, `INSERT INTO ${DB}.dbo.orders (note) VALUES (@note);`, { note });
}

async function succeeded(opPromise) {
    const op = await opPromise;
    assert.equal(op.status, 'succeeded', opSummary(op));
    return op;
}

/** Takes a LOG backup on the primary and waits until `secondary` has restored it. */
async function shipTo(secondary) {
    const { operation } = await api.post(`/api/databases/${dbId}/backups`, { type: 'LOG' });
    const op = await succeeded(api.waitOp(operation.id));
    const relPath = op.ctx.relPath;
    await waitFor(`${relPath} restored on ${secondary}`, async () => {
        const rows = await api.get(`/api/databases/${dbId}/restores?limit=20`);
        return rows.some((r) => r.server_name === secondary && r.rel_path === relPath && r.outcome === 'success');
    });
}

async function failover(target, body) {
    const { operation } = await api.post(`/api/databases/${dbId}/failover`, { server_id: ids[target], ...body });
    return succeeded(api.waitOp(operation.id));
}

before(async () => {
    secrets = await startStack();
    for (const s of ['sql1', 'sql2']) await waitFor(`${s} to accept connections`, () => q(s, 'SELECT 1 AS ok;'), { timeout: 300_000, interval: 3000 });
    await waitFor('the controller', controllerUp, { timeout: 120_000 });
    await api.login(secrets.adminPassword);
    // Short loops so the scenario runs in minutes; reminders off so step 6 counts exactly.
    await api.put('/api/settings', {
        'health.interval_seconds': 5,
        'restore.poll_seconds': 5,
        'alerts.interval_seconds': 5,
        'alerts.debounce_seconds': 5,
        'alerts.reminder_hours': 0,
        'alerts.lag_threshold_minutes': 120,
        'retention.enabled': false,
    });
});

after(() => stopStack());

test('1. register servers, manage a database, add a secondary', async () => {
    for (const name of ['sql1', 'sql2']) {
        const s = await api.post('/api/servers', {
            name,
            host: name,
            port: 1433,
            username: 'sa',
            password: secrets.saPassword,
            sql_backup_root: '/var/opt/mssql/backup',
            encrypt: true,
            trust_server_cert: true,
            enabled: true,
        });
        ids[name] = s.id;
    }
    await waitFor('both servers reachable', async () => (await api.get('/api/servers')).every((s) => s.health?.ok));

    await q('sql1', `CREATE DATABASE ${DB};`);
    await q('sql1', `ALTER DATABASE ${DB} SET RECOVERY FULL;`);
    await q('sql1', `CREATE TABLE ${DB}.dbo.orders (id int IDENTITY(1, 1) NOT NULL, note nvarchar(100) NOT NULL, CONSTRAINT PK_orders PRIMARY KEY CLUSTERED (id));`);
    await insertRow('sql1', 'before shipping');

    const managed = await api.post('/api/databases', { server_id: ids.sql1, name: DB });
    dbId = managed.database.id;
    await succeeded(api.waitOp(managed.operation.id));

    const seed = await api.post(`/api/databases/${dbId}/secondaries`, { server_id: ids.sql2, source: 'new_full', restore_mode: 'norecovery' });
    await succeeded(api.waitOp(seed.operation.id));
    await waitFor('sql2 shipping', async () => (await replica('sql2'))?.chain_state === 'ok');
    assert.equal(await dbState('sql2'), 'RESTORING');
});

test('2. a shipped row is on sql2 after a failover with a tail-log backup', async () => {
    await insertRow('sql1', 'shipped before failover');
    await shipTo('sql2');
    await insertRow('sql1', 'only in the tail log');

    const op = await failover('sql2', { tail_log: true });
    assert.equal(op.type, 'planned_failover');
    assert.equal(await primaryName(), 'sql2');
    assert.equal(await dbState('sql2'), 'ONLINE');
    assert.equal(await rowCount('sql2', 'shipped before failover'), 1);
    assert.equal(await rowCount('sql2', 'only in the tail log'), 1, 'the tail-log backup carried the last row');
    assert.equal(await dbState('sql1'), 'RESTORING', 'the old primary waits as the new secondary');
    assert.equal((await replica('sql1')).role, 'secondary');
});

test('3. fail back to sql1', async () => {
    await insertRow('sql2', 'written on sql2');
    await failover('sql1', { tail_log: true });
    assert.equal(await primaryName(), 'sql1');
    assert.equal(await rowCount('sql1', 'written on sql2'), 1);
    await insertRow('sql1', 'after failback');
    await shipTo('sql2');
});

test('4. with sql1 down, a failover keeps shipped rows and loses the unshipped one', async () => {
    await insertRow('sql1', 'shipped before the crash');
    await shipTo('sql2');
    await insertRow('sql1', 'never shipped');

    compose('stop', 'sql1');
    await waitFor('sql1 reported unreachable', async () => (await api.get('/api/servers')).find((s) => s.name === 'sql1').health?.ok === false, { timeout: 60_000 });

    const preview = await api.get(`/api/databases/${dbId}/failover-preview?server_id=${ids.sql2}`);
    assert.equal(preview.plannedPossible, false, 'no lossless failover with the primary down');
    await assert.rejects(api.post(`/api/databases/${dbId}/failover`, { server_id: ids.sql2, tail_log: false }), /400/, 'data loss must be accepted');

    const op = await failover('sql2', { tail_log: false, accept_data_loss: true });
    assert.equal(op.type, 'forced_failover');
    assert.equal(await primaryName(), 'sql2');
    assert.equal(await rowCount('sql2', 'shipped before the crash'), 1);
    assert.equal(await rowCount('sql2', 'never shipped'), 0, 'the unshipped row is lost, as the dialog warned');
    assert.equal((await replica('sql1')).role, 'diverged');
});

test('5. the old primary comes back out of sync and is reinitialized', async () => {
    compose('start', 'sql1');
    await waitFor('sql1 to accept connections', () => q('sql1', 'SELECT 1 AS ok;'), { timeout: 300_000, interval: 3000 });
    await waitFor('sql1 reported reachable', async () => (await api.get('/api/servers')).find((s) => s.name === 'sql1').health?.ok, { timeout: 60_000 });
    assert.equal(await dbState('sql1'), 'ONLINE', 'the old primary came back online on its own');
    assert.equal(await rowCount('sql1', 'never shipped'), 1, 'and still holds the row the new primary never got');
    await waitFor('the split-brain alert', async () => (await api.get('/api/alerts?status=active')).some((a) => a.kind === 'split_brain'), { timeout: 60_000 });

    const { operation } = await api.post(`/api/databases/${dbId}/replicas/${ids.sql1}/reseed`, { confirm: DB, safety_backup: true, source: 'new_full', restore_mode: 'norecovery' });
    const op = await succeeded(api.waitOp(operation.id));
    assert.equal(op.type, 'reseed');
    assert.match(op.steps.find((s) => s.name === 'safety_backup').detail, /DIVERGED/, 'a safety backup of the old copy was kept');

    assert.equal(await dbState('sql1'), 'RESTORING');
    assert.equal((await replica('sql1')).role, 'secondary');
    await insertRow('sql2', 'after reinitialize');
    await shipTo('sql1');
    const r = await replica('sql1');
    assert.equal(r.chain_state, 'ok');
    assert.equal(r.lag.files, 0, 'caught up');
});

test('6. one notification per problem, none re-sent after a restart', async () => {
    const unreachable = (m) => m.message.includes('Server sql2 is unreachable') && !m.message.includes('RESOLVED');
    const resolved = (m) => m.message.includes('RESOLVED') && m.message.includes('Server sql2 is unreachable');
    const sent = await mockMessages();
    assert.ok(sent.some((m) => m.message.includes('Server sql1 is unreachable')), 'step 4 sent an alert for sql1');

    compose('stop', 'sql2');
    await waitFor('the sql2 alert', async () => (await mockMessages()).some(unreachable), { timeout: 90_000 });

    compose('restart', 'controller');
    await waitFor('the controller after restart', controllerUp, { timeout: 120_000 });
    await sleep(30_000); // several alert evaluations, well past the debounce
    assert.equal((await mockMessages()).filter(unreachable).length, 1, 'the restart did not re-send the active alert');

    compose('start', 'sql2');
    await waitFor('the sql2 alert to resolve', async () => (await mockMessages()).some(resolved), { timeout: 300_000, interval: 3000 });
    await sleep(15_000);
    const all = await mockMessages();
    assert.equal(all.filter(resolved).length, 1, 'resolved once');
    assert.equal(all.filter(unreachable).length, 1, 'still only one alert for sql2');
});
