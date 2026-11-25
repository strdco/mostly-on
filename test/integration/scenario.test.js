// The whole brief, end to end, against real SQL Server containers. Mostly-On
// connects as the restricted login "mostly_on" (no sysadmin); the compose
// sql-setup service installed the signed helper procedures it works through.
//   1. register both servers, manage a new database on sql1, add sql2 as its secondary
//   1b. the restricted login can only act through the helper procedures, within their guard rails
//   2. ship a row, fail over to sql2 (tail-log backup), the row is there
//   3. fail back to sql1; a row written on sql2 comes along
//   4. stop sql1, fail over without it: shipped rows survive, the unshipped one is lost
//   5. start sql1: its copy is out of sync; reinitialize it and it ships again
//   5b. restore copies as they were at a moment (from the backups, and after a fresh log backup)
//   5c. roll the database back to a moment; the secondary follows the new branch
//   6. alerts: one notification per problem, none re-sent after a controller restart
//   6b. a log-shipped database switched to BULK_LOGGED recovery raises an alert; back in FULL, shipping catches up
//   7. a backup file replaced after it was taken is never restored
//   8. system databases and SIMPLE databases are backed up on their own server only
//   9. paired servers manage new databases by themselves, ship them to each other, and stop managing dropped ones
//
// Run: npm run test:integration   (Docker required; takes several minutes)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Api, startStack, stopStack, compose, waitFor, sqlQuery, sqlAs, controllerUp, mockMessages, opSummary, sleep } from './harness.js';

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
const dbOwner = async (server) => (await q(server, 'SELECT SUSER_SNAME(owner_sid) AS owner FROM sys.databases WHERE name=@name;', { name: DB }))[0]?.owner ?? null;
const asMostlyOn = (server, text) => sqlAs('mostly_on', secrets.moPassword, server, text);

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
    // The sql-setup service creates the mostly_on login, then installs the helpers. Registering a
    // server before that raises real but misleading alerts ("Login failed", "not installed").
    for (const s of ['sql1', 'sql2']) {
        await waitFor(`the setup script on ${s}`, async () => (await asMostlyOn(s, 'SELECT master.mostly_on.helper_version() AS v;'))[0].v != null, { timeout: 300_000, interval: 3000 });
    }
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
            username: 'mostly_on',
            password: secrets.moPassword,
            sql_backup_root: '/var/opt/mssql/backup',
            encrypt: true,
            trust_server_cert: true,
            enabled: true,
        });
        ids[name] = s.id;
    }
    await waitFor('both servers reachable and set up (sql-setup service)', async () => (await api.get('/api/servers')).every((s) => s.health?.ok && s.health.setup?.ready), {
        timeout: 300_000,
        interval: 3000,
    });
    const [s1] = await api.get('/api/servers');
    assert.equal(s1.health.setup.login, 'mostly_on');

    // The database belongs to app_owner, a login that exists only on sql1 for now.
    await q('sql1', "CREATE LOGIN app_owner WITH PASSWORD=N'App-Owner-1!x', CHECK_POLICY=OFF;");
    await q('sql1', `CREATE DATABASE ${DB};`);
    await q('sql1', `ALTER DATABASE ${DB} SET RECOVERY FULL;`);
    await q('sql1', `ALTER AUTHORIZATION ON DATABASE::${DB} TO app_owner;`);
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

test('1a. a database with a secondary cannot stop being managed, nor its servers be removed', async () => {
    await assert.rejects(api.post(`/api/databases/${dbId}/unmanage`, { confirm: DB }), (err) => err.status === 409 && /Remove its secondaries first \(sql2/.test(err.message));
    assert.ok((await api.get('/api/databases')).some((d) => d.id === dbId), 'still managed');
    // Nor can a server holding a copy be removed.
    assert.match((await api.get(`/api/servers/${ids.sql2}`)).remove_blocker, /still holds 1 secondary copy of managed databases/);
    await assert.rejects(api.call('DELETE', `/api/servers/${ids.sql2}`), (err) => err.status === 409);
});

test('1b. the restricted login can only act through the helper procedures', async () => {
    await assert.rejects(asMostlyOn('sql1', `BACKUP DATABASE ${DB} TO DISK=N'/var/opt/mssql/backup/x.bak';`), /not able to access|permission|terminating abnormally/i, 'no direct BACKUP');
    await assert.rejects(asMostlyOn('sql1', `SELECT COUNT(*) AS n FROM ${DB}.dbo.orders;`), /not able to access/i, 'no access to the data');
    // System databases: backed up (test 8), but never restored or changed; tempdb never touched.
    const neverChanged = /never restores or changes them/;
    await assert.rejects(asMostlyOn('sql1', "EXEC master.mostly_on.restore_database @db=N'master', @path=N'/var/opt/mssql/backup/m.bak', @replace=1;"), neverChanged);
    await assert.rejects(asMostlyOn('sql1', "EXEC master.mostly_on.tail_log @db=N'model', @path=N'/var/opt/mssql/backup/m.trn', @name=N'x', @description=N'x', @mode='planned';"), neverChanged);
    await assert.rejects(asMostlyOn('sql1', "EXEC master.mostly_on.set_state @db=N'msdb', @state='OFFLINE';"), neverChanged);
    await assert.rejects(asMostlyOn('sql1', "EXEC master.mostly_on.take_backup @db=N'tempdb', @type='FULL', @path=N'/var/opt/mssql/backup/t.bak', @name=N'x', @description=N'x';"), /never touches tempdb/);
    await assert.rejects(
        asMostlyOn('sql1', "EXEC master.mostly_on.take_backup @db=N'master', @type='LOG', @path=N'/var/opt/mssql/backup/m.trn', @name=N'x', @description=N'x';"),
        /only allows full backups of master/,
    );
    await assert.rejects(
        asMostlyOn('sql1', `EXEC master.mostly_on.take_backup @db=N'${DB}', @type='FULL', @path=N'/tmp/x.bak', @name=N'x', @description=N'x';`),
        /refused the path/,
    );
    await assert.rejects(
        asMostlyOn('sql1', `EXEC master.mostly_on.take_backup @db=N'${DB}', @type='FULL', @path=N'/var/opt/mssql/backup/../x.bak', @name=N'x', @description=N'x';`),
        /refused a file path/,
    );
    await assert.rejects(asMostlyOn('sql1', 'CREATE LOGIN sneaky WITH PASSWORD=N\'Sneaky-1!x\';'), /permission/i, 'no server-level rights of its own');
    // recover only re-owns a copy Mostly-On restored itself, and never to its own login.
    const [kept] = await asMostlyOn('sql1', `DECLARE @me varbinary(85)=SUSER_SID(); EXEC master.mostly_on.recover @db=N'${DB}', @owner_sid=@me, @owner_name=N'mostly_on';`);
    assert.equal(kept.matched_by, 'kept', 'recover leaves the owner of a database it did not restore');
    await assert.rejects(asMostlyOn('sql1', `SELECT COUNT(*) AS n FROM ${DB}.dbo.orders;`), /not able to access/i, 'still no access to the data');
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

    // app_owner has no login on sql2: the owner falls back to sa, never to mostly_on, and an event says why.
    assert.equal(await dbOwner('sql2'), 'sa');
    assert.match(op.steps.find((s) => s.name === 'recover').detail, /owner: sa \(app_owner, the owner on the old primary, has no login on sql2\)/);
    const events = await api.get(`/api/events?database_id=${dbId}&limit=50`);
    assert.ok(events.some((e) => /is now owned by sa: app_owner/.test(e.message)), 'the fallback is reported');
});

test('3. fail back to sql1', async () => {
    await insertRow('sql2', 'written on sql2');
    await shipTo('sql1'); // backups on sql2 (owned by the stand-in sa) must not replace the remembered owner
    await failover('sql1', { tail_log: true });
    assert.equal(await primaryName(), 'sql1');
    assert.equal(await dbOwner('sql1'), 'app_owner', 'failing back restores the real owner (same SID on sql1)');
    assert.equal(await rowCount('sql1', 'written on sql2'), 1);
    await insertRow('sql1', 'after failback');
    await shipTo('sql2');
});

test('4. with sql1 down, a failover keeps shipped rows and loses the unshipped one', async () => {
    // app_owner now also exists on sql2, with a different SID: matched by name.
    await q('sql2', "CREATE LOGIN app_owner WITH PASSWORD=N'App-Owner-1!x', CHECK_POLICY=OFF;");
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
    assert.equal(await dbOwner('sql2'), 'app_owner', 'owner matched by login name on sql2');
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

/** Takes a LOG backup on the primary; returns its operation. */
async function logBackup() {
    const { operation } = await api.post(`/api/databases/${dbId}/backups`, { type: 'LOG' });
    return succeeded(api.waitOp(operation.id));
}

/** "Now" on a server's clock, as an ISO string (msdb keeps whole seconds: leave gaps of 2+ s around it). */
async function serverNow(server) {
    return (await q(server, 'SELECT SYSUTCDATETIME() AS now;'))[0].now.toISOString();
}

async function pointInTime(body) {
    const { operation } = await api.post(`/api/databases/${dbId}/point-in-time`, body);
    return succeeded(api.waitOp(operation.id));
}

const countIn = async (server, dbName, note) => (await q(server, `SELECT COUNT(*) AS n FROM ${dbName}.dbo.orders WHERE note=@note;`, { note }))[0].n;

test('5b. a copy restored to a moment has what was there then, and the original is untouched', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    await insertRow(primary, 'pitr before');
    await logBackup();
    await sleep(2500);
    const moment = await serverNow(primary);
    await sleep(2500);
    await insertRow(primary, 'pitr after');
    await logBackup();

    const range = await api.get(`/api/databases/${dbId}/restore-range`);
    assert.ok(range.from && new Date(range.from) < new Date(moment), `restorable from ${range.from}`);
    assert.ok(range.untilNow, 'the primary is up, so any moment until now');

    const op = await pointInTime({ mode: 'copy', at: moment, target_server_id: ids[secondary], new_name: 'ItShop_then' });
    assert.equal(op.steps.find((s) => s.name === 'fresh_log').detail, 'Not needed: the backups already reach the moment');
    assert.equal(await countIn(secondary, 'ItShop_then', 'pitr before'), 1);
    assert.equal(await countIn(secondary, 'ItShop_then', 'pitr after'), 0, 'the row written after the moment is not in the copy');
    assert.equal(await rowCount(primary, 'pitr after'), 1, 'the original keeps it');
    assert.equal((await q(secondary, "SELECT SUSER_SNAME(owner_sid) AS owner FROM sys.databases WHERE name=N'ItShop_then';"))[0].owner, await dbOwner(primary), 'same owner as the original');

    // A moment newer than the last log backup, on the primary's own server: a log backup is taken first,
    // and the copy's files do not collide with the original's.
    await insertRow(primary, 'pitr fresh');
    const latest = await serverNow(primary); // "right now": the log backup must start after it
    const op2 = await pointInTime({ mode: 'copy', at: latest, target_server_id: ids[primary], new_name: 'ItShop_now' });
    assert.match(op2.steps.find((s) => s.name === 'fresh_log').detail, /LOG backup #\d+/);
    assert.equal(await countIn(primary, 'ItShop_now', 'pitr fresh'), 1);

    await assert.rejects(
        api.post(`/api/databases/${dbId}/point-in-time`, { mode: 'copy', at: latest, target_server_id: ids[primary], new_name: 'ItShop_now' }),
        /already exists/,
    );
    await q(secondary, 'DROP DATABASE ItShop_then;');
    await q(primary, 'DROP DATABASE ItShop_now;');
});

test('5c. a rollback puts the database back to a moment; the secondary follows', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    await insertRow(primary, 'rb keep');
    await logBackup();
    await sleep(2500);
    const moment = await serverNow(primary);
    await sleep(2500);
    await insertRow(primary, 'rb gone'); // never in a log backup: only the tail-log backup has it
    const owner = await dbOwner(primary);

    await assert.rejects(api.post(`/api/databases/${dbId}/point-in-time`, { mode: 'rollback', at: moment, confirm: 'nope' }), /Type the database name/);
    const op = await pointInTime({ mode: 'rollback', at: moment, confirm: DB });
    assert.equal(op.type, 'pitr_rollback');
    assert.equal(await dbState(primary), 'ONLINE');
    assert.equal(await rowCount(primary, 'rb keep'), 1);
    assert.equal(await rowCount(primary, 'rb gone'), 0, 'the change after the moment is rolled back');
    assert.equal(await rowCount(primary, 'pitr after'), 1, 'earlier changes stay');
    assert.match(op.steps.find((s) => s.name === 'secondaries').detail, new RegExp(`${secondary}: restored to the moment`));
    assert.match(op.steps.find((s) => s.name === 'record_fork').detail, /new branch/);
    assert.equal(await dbOwner(primary), owner, 'the owner is kept');

    const files = await api.get(`/api/databases/${dbId}/backups?limit=100`);
    const tail = files.find((f) => f.is_tail && f.operation_id === op.id);
    assert.ok(tail && tail.file_status === 'present', 'the tail-log backup with the rolled-back change stays on the share');

    // The secondary continues across the new branch: the first log after the rollback reaches it.
    assert.equal((await replica(secondary)).chain_state, 'ok');
    await insertRow(primary, 'after rollback');
    await shipTo(secondary);
    const r = await replica(secondary);
    assert.equal(r.chain_state, 'ok', r.chain_reason);
    assert.equal(r.lag.files, 0, 'caught up');
});

test('5d. a delayed secondary holds back young logs, can never take over, and catches up once the delay is removed', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    const url = `/api/databases/${dbId}/replicas/${ids[secondary]}`;
    let relPath;
    const restored = async () => (await api.get(`/api/databases/${dbId}/restores?limit=20`)).some((r) => r.server_name === secondary && r.rel_path === relPath && r.outcome === 'success');
    try {
        assert.equal((await api.put(url, { restore_delay_minutes: 60 })).restore_delay_minutes, 60);
        await insertRow(primary, 'while delayed');
        relPath = (await logBackup()).ctx.relPath;
        await sleep(15_000); // the backup's own nudge, plus a few restore polls
        assert.equal(await restored(), false, 'a log younger than the delay is not restored');
        const r = await replica(secondary);
        assert.equal(r.chain_state, 'ok', 'waiting is not a failure');
        assert.ok(r.lag.files >= 1, 'the held-back log is counted as waiting');

        // Never a failover target, whichever way, and nothing changes.
        const refused = (err) => err.status === 409 && /restore delay/.test(err.message);
        await assert.rejects(api.get(`/api/databases/${dbId}/failover-preview?server_id=${ids[secondary]}`), refused);
        await assert.rejects(api.post(`/api/databases/${dbId}/failover`, { server_id: ids[secondary], tail_log: true }), refused);
        await assert.rejects(api.post(`/api/databases/${dbId}/failover`, { server_id: ids[secondary], tail_log: false, accept_data_loss: true }), refused);
        const plan = await api.get(`/api/servers/${ids[primary]}/switchover-plan?to=${ids[secondary]}`);
        assert.match(plan.databases.find((d) => d.name === DB).problem, /restore delay/);
        assert.equal(await primaryName(), primary);
        // Express closes idle databases (AUTO_CLOSE), so the primary may be briefly RECOVERING; a
        // failover would have left it RESTORING after its tail-log backup.
        await waitFor(`${DB} online on ${primary}`, async () => (await dbState(primary)) === 'ONLINE', { timeout: 30_000 });

        // Pause and resume.
        const paused = await api.post(`${url}/pause`, { hours: 1 });
        assert.ok(new Date(paused.restores_paused_until) > new Date(), 'paused for an hour');
        await api.post(`${url}/resume`);
        assert.equal(await restored(), false, 'resuming does not skip the delay');
    } finally {
        await api.put(url, { restore_delay_minutes: 0 });
    }
    // Without its delay it catches up right away, and is an ordinary secondary again.
    await waitFor(`${relPath} restored on ${secondary}`, restored, { timeout: 60_000 });
    await waitFor('the catch-up to finish', async () => (await replica(secondary)).restores_paused_until === null, { timeout: 60_000 });
    const r = await replica(secondary);
    assert.equal(r.lag.files, 0, 'caught up');
    assert.equal(r.restore_delay_minutes, 0);
});

test('5e. a readable secondary stays readable after it is reinitialized', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    const url = `/api/databases/${dbId}/replicas/${ids[secondary]}`;
    const readable = async () => (await replica(secondary)).live?.isInStandby === true;
    try {
        await api.put(url, { restore_mode: 'standby' });
        await insertRow(primary, 'readable before');
        await shipTo(secondary);
        await waitFor(`${DB} readable on ${secondary}`, readable, { timeout: 60_000 });
        const first = (await replica(secondary)).standby_undo_file;
        assert.match(first, /\.\d{8}T\d{6}Z\.tuf$/, 'switched to readable: a new undo file');

        // Reinitializing restores a FULL over the readable copy and leaves its undo file behind.
        // SQL Server refuses to overwrite that file for a login that is not sysadmin, so the
        // copy must start another one, or it never becomes readable again (error 3441).
        const { operation } = await api.post(`${url}/reseed`, { confirm: DB, safety_backup: false, source: 'new_full', restore_mode: 'standby' });
        await succeeded(api.waitOp(operation.id));
        await insertRow(primary, 'readable after reinitializing');
        await shipTo(secondary);
        await waitFor(`${DB} readable on ${secondary} again`, readable, { timeout: 60_000 });
        const second = (await replica(secondary)).standby_undo_file;
        assert.notEqual(second, first, 'a new undo file after reinitializing');
        assert.equal(await rowCount(secondary, 'readable after reinitializing'), 1, 'readers can query the newest data');

        // Readable from restore to restore: the copy keeps the undo file it uses.
        await insertRow(primary, 'readable, next log');
        await shipTo(secondary);
        assert.equal((await replica(secondary)).standby_undo_file, second);
        assert.equal(await rowCount(secondary, 'readable, next log'), 1);
    } finally {
        await api.put(url, { restore_mode: 'norecovery' });
    }
    await shipTo(secondary); // back to not readable for the tests that follow
});

test('5f. a server limited to one backup or restore at a time runs them one after the other', async () => {
    const primary = await primaryName();
    const url = `/api/servers/${ids[primary]}`;
    try {
        assert.equal((await api.put(url, { max_parallel: 1 })).work.limit, 1);
        await insertRow(primary, 'one at a time');
        // A LOG backup may run during a FULL backup of the same database; the limit makes it wait.
        const full = (await api.post(`/api/databases/${dbId}/backups`, { type: 'FULL' })).operation.id;
        const log = (await api.post(`/api/databases/${dbId}/backups`, { type: 'LOG' })).operation.id;
        await succeeded(api.waitOp(full));
        await succeeded(api.waitOp(log));
        // SQL Server's own record: the LOG backup started only once the FULL backup had finished.
        const rows = await q(primary, 'SELECT b.description, b.backup_start_date AS started, b.backup_finish_date AS finished FROM msdb.dbo.backupset AS b WHERE b.description IN (@full, @log);', {
            full: `mostly-on op:${full}`,
            log: `mostly-on op:${log}`,
        });
        const at = Object.fromEntries(rows.map((r) => [r.description, r]));
        assert.ok(at[`mostly-on op:${log}`].started >= at[`mostly-on op:${full}`].finished, `LOG started ${at[`mostly-on op:${log}`].started.toISOString()}, FULL finished ${at[`mostly-on op:${full}`].finished.toISOString()}`);
        // Health checks have their own connections: the server stayed reachable throughout.
        assert.equal((await api.get(url)).health.ok, true);
    } finally {
        assert.equal((await api.put(url, { max_parallel: null })).work.limit, 2, 'back to the default');
    }
});

test('6. one notification per problem, none re-sent after a restart', async () => {
    const unreachable = (m) => m.message.includes('Server sql2 is unreachable') && !m.message.includes('RESOLVED');
    const resolved = (m) => m.message.includes('RESOLVED') && m.message.includes('Server sql2 is unreachable');
    const sent = await mockMessages();
    assert.ok(sent.some((m) => m.message.includes('Server sql1 is unreachable')), 'step 4 sent an alert for sql1');
    // Only what this step sends counts: earlier steps may have had their own sql2 alerts.
    const since = async () => (await mockMessages()).slice(sent.length);

    compose('stop', 'sql2');
    await waitFor('the sql2 alert', async () => (await since()).some(unreachable), { timeout: 90_000 });

    compose('restart', 'controller');
    await waitFor('the controller after restart', controllerUp, { timeout: 120_000 });
    await sleep(30_000); // several alert evaluations, well past the debounce
    assert.equal((await since()).filter(unreachable).length, 1, 'the restart did not re-send the active alert');

    compose('start', 'sql2');
    await waitFor('the sql2 alert to resolve', async () => (await since()).some(resolved), { timeout: 300_000, interval: 3000 });
    await sleep(15_000);
    const all = await since();
    assert.equal(all.filter(resolved).length, 1, 'resolved once');
    assert.equal(all.filter(unreachable).length, 1, 'still only one alert for sql2');
});

test('6b. a log-shipped database out of FULL recovery raises an alert; back in FULL, shipping catches up', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    const active = async () => (await api.get('/api/alerts?status=active')).find((a) => a.kind === 'recovery_model' && a.database_id === dbId);
    try {
        await q(primary, `ALTER DATABASE ${DB} SET RECOVERY BULK_LOGGED;`);
        const alert = await waitFor('the recovery model alert', active, { timeout: 90_000 });
        assert.equal(alert.severity, 'warn');
        assert.equal(
            alert.message,
            `${DB} is in BULK_LOGGED recovery on its primary ${primary}, so Mostly-On takes no log backups of it and its secondaries fall behind. Switch it back to FULL recovery; shipping then catches up by itself.`,
        );
        await assert.rejects(api.post(`/api/databases/${dbId}/backups`, { type: 'LOG' }), (err) => err.status === 409 && /BULK_LOGGED recovery/.test(err.message));
        await insertRow(primary, 'during BULK_LOGGED');
    } finally {
        await q(primary, `ALTER DATABASE ${DB} SET RECOVERY FULL;`);
    }
    // The log chain is intact: the next log backup carries everything since the last one.
    await shipTo(secondary);
    await waitFor('the alert to resolve', async () => !(await active()), { timeout: 90_000 });
    assert.equal((await replica(secondary)).chain_state, 'ok');
});

// Last, as it leaves shipping stopped (and alerts about it).
test('7. a backup file replaced after it was taken is never restored', async () => {
    const primary = await primaryName();
    const secondary = primary === 'sql1' ? 'sql2' : 'sql1';
    // Pause the secondary, so the file can be replaced before it is restored.
    await api.put(`/api/servers/${ids[secondary]}`, { enabled: false });
    // A restore pass that was already running finishes what it finds, which could include the log
    // taken next (say, one the schedule just took). No new pass starts on a disabled server.
    await waitFor(`no restore running on ${secondary}`, async () => !(await api.get(`/api/databases/${dbId}`)).busy.includes(`restore:${ids[secondary]}`), { timeout: 60_000, interval: 250 });
    await insertRow(primary, 'in the replaced log');
    const { operation } = await api.post(`/api/databases/${dbId}/backups`, { type: 'LOG' });
    const relPath = (await succeeded(api.waitOp(operation.id))).ctx.relPath;
    // Anyone allowed to back up the database can write another backup under the same, predictable name.
    await q(primary, `BACKUP LOG ${DB} TO DISK=@path WITH COPY_ONLY, INIT, FORMAT;`, { path: `/var/opt/mssql/backup/${relPath}` });

    await api.put(`/api/servers/${ids[secondary]}`, { enabled: true });
    await waitFor('shipping to stop', async () => (await replica(secondary)).chain_state === 'broken', { timeout: 120_000 });
    assert.match((await replica(secondary)).chain_reason, /no longer holds the backup Mostly-On took/);
    const rows = await api.get(`/api/databases/${dbId}/restores?limit=20`);
    assert.ok(!rows.some((r) => r.server_name === secondary && r.rel_path === relPath && r.outcome === 'success'), 'the replaced file was not restored');
});

// Backups-only databases: separate databases and their own folders, so it does not
// matter that test 7 left shipping of the test database stopped.
test('8. system databases and SIMPLE databases are backed up on their own server only', async () => {
    const SCRATCH = 'ItScratch';
    const managed = [];
    const conflict = (re) => (err) => err.status === 409 && re.test(err.message);
    const dbOf = (id) => api.get(`/api/databases/${id}`);
    const [{ model: modelWas }] = await q('sql2', "SELECT recovery_model_desc AS model FROM sys.databases WHERE name=N'model';");
    try {
        // Discovery lists master, model and msdb on every server, and never tempdb.
        await waitFor('the system databases to be discovered', async () => {
            const found = await api.get('/api/discovered?include_dismissed=1');
            return ['sql1', 'sql2'].every((s) => ['master', 'model', 'msdb'].every((n) => found.some((x) => x.server_name === s && x.name === n && x.system && x.manage_as === 'backup_only')));
        });
        assert.ok(!(await api.get('/api/discovered?include_dismissed=1')).some((x) => x.name === 'tempdb'));

        // master on both servers: two databases, each in a folder of its own server, FULL backups only.
        const master = {};
        for (const s of ['sql1', 'sql2']) {
            const m = await api.post('/api/databases', { server_id: ids[s], name: 'master' });
            master[s] = m.database.id;
            managed.push(m.database.id);
            assert.equal(m.database.backup_only, true);
            assert.deepEqual(m.database.schedules.map((x) => x.backup_type), ['FULL']);
            assert.match((await succeeded(api.waitOp(m.operation.id))).ctx.relPath, new RegExp(`^master@${s}/FULL/master_FULL_\\d{8}_\\d{6}_${s}\\.bak$`));
        }
        assert.notEqual(master.sql1, master.sql2);
        await assert.rejects(api.post('/api/databases', { server_id: ids.sql1, name: 'master' }), conflict(/already managed/));
        const opsBefore = (await dbOf(master.sql1)).operations.length;
        await assert.rejects(api.post(`/api/databases/${master.sql1}/backups`, { type: 'DIFF' }), conflict(/takes only full backups of master/));
        assert.equal((await dbOf(master.sql1)).operations.length, opsBefore, 'a refused DIFF leaves no operation behind');
        await assert.rejects(api.put(`/api/databases/${master.sql1}/schedules/LOG`, { kind: 'interval', interval_minutes: 5 }), conflict(/takes only full backups of master/));

        // A SIMPLE database of the same name on both servers.
        for (const s of ['sql1', 'sql2']) {
            await q(s, `IF DB_ID(N'${SCRATCH}') IS NULL CREATE DATABASE ${SCRATCH};`);
            await q(s, `ALTER DATABASE ${SCRATCH} SET RECOVERY SIMPLE;`);
        }
        const scratch = {};
        for (const s of ['sql1', 'sql2']) {
            const m = await api.post('/api/databases', { server_id: ids[s], name: SCRATCH });
            scratch[s] = m.database.id;
            managed.push(m.database.id);
            assert.deepEqual(Object.fromEntries(m.database.schedules.map((x) => [x.backup_type, x.enabled])), { FULL: true, DIFF: false, LOG: true }, 'DIFF is off by default');
            await succeeded(api.waitOp(m.operation.id));
        }
        const id = scratch.sql1;
        await assert.rejects(api.post(`/api/databases/${id}/backups`, { type: 'LOG' }), conflict(/takes only full backups of databases in SIMPLE or BULK_LOGGED recovery, and ItScratch on sql1 is in SIMPLE recovery/));
        // A LOG schedule is skipped quietly: no failed operation, no alert.
        await api.put(`/api/databases/${id}/schedules/LOG`, { kind: 'interval', interval_minutes: 1, enabled: true });
        await waitFor('the LOG schedule to be skipped', async () => (await dbOf(id)).schedules.find((x) => x.backup_type === 'LOG').last_status === 'skipped: SIMPLE recovery', {
            timeout: 150_000,
            interval: 3000,
        });
        assert.ok(!(await dbOf(id)).operations.some((o) => o.status === 'failed'), 'no failed operation');
        assert.ok(!(await api.get('/api/alerts?status=active')).some((a) => a.database_id === id), 'no alert');
        // Never shipped or restored.
        await assert.rejects(api.post(`/api/databases/${id}/secondaries`, { server_id: ids.sql2, source: 'new_full', restore_mode: 'norecovery' }), conflict(/managed as backups only/));
        await assert.rejects(api.get(`/api/databases/${id}/restore-range`), conflict(/does not perform managed restores\. Backup files live in ItScratch@sql1/));

        // Switched to FULL recovery, it gets LOG backups (the first one is a FULL, which starts the log chain).
        await q('sql1', `ALTER DATABASE ${SCRATCH} SET RECOVERY FULL;`);
        await waitFor('the health check to see FULL recovery', async () => (await dbOf(id)).recovery_model === 'FULL');
        let started = await api.post(`/api/databases/${id}/backups`, { type: 'LOG' });
        assert.equal(started.type, 'FULL');
        await succeeded(api.waitOp(started.operation.id));
        started = await api.post(`/api/databases/${id}/backups`, { type: 'LOG' });
        assert.equal(started.type, 'LOG');
        assert.match((await succeeded(api.waitOp(started.operation.id))).ctx.relPath, new RegExp(`^${SCRATCH}@sql1/LOG/`));
        assert.equal((await dbOf(id)).can_ship, true, 'it could be log shipped now');
        await q('sql1', `ALTER DATABASE ${SCRATCH} SET RECOVERY SIMPLE;`);
        await waitFor('the health check to see SIMPLE recovery', async () => (await dbOf(id)).recovery_model === 'SIMPLE');
        await assert.rejects(api.post(`/api/databases/${id}/backups`, { type: 'LOG' }), conflict(/SIMPLE recovery/));

        // model in FULL recovery: LOG backups, like any database in FULL recovery.
        await q('sql2', 'ALTER DATABASE model SET RECOVERY FULL;');
        const model = await api.post('/api/databases', { server_id: ids.sql2, name: 'model' });
        managed.push(model.database.id);
        await succeeded(api.waitOp(model.operation.id));
        started = await api.post(`/api/databases/${model.database.id}/backups`, { type: 'LOG' });
        assert.match((await succeeded(api.waitOp(started.operation.id))).ctx.relPath, new RegExp(`^model@sql2/(LOG|FULL)/`));

        // Another tool's FULL backup of master is noted on its page, without an alert.
        await q('sql1', "BACKUP DATABASE master TO DISK=N'/var/opt/mssql/backup/outside-master.bak' WITH INIT;");
        const noted = await waitFor('the outside backup to be noted', async () => (await dbOf(master.sql1)).latest_foreign, { timeout: 150_000, interval: 3000 });
        assert.equal(noted.type, 'FULL');
        assert.ok(noted.acknowledged_at, 'nothing to act on');
        assert.ok(!(await api.get('/api/alerts?status=active')).some((a) => a.kind === 'foreign_backup' && a.database_id === master.sql1));

        // Stop backing up master on sql2: it is offered there again, and sql1's master stays managed.
        await api.post(`/api/databases/${master.sql2}/unmanage`, { confirm: 'master' });
        assert.ok((await api.get('/api/discovered?include_dismissed=1')).some((x) => x.server_name === 'sql2' && x.name === 'master'));
        assert.ok((await api.get('/api/databases')).some((d) => d.id === master.sql1));
    } finally {
        for (const id of managed) await api.post(`/api/databases/${id}/unmanage`, { confirm: (await dbOf(id).catch(() => null))?.name }).catch(() => {});
        for (const s of ['sql1', 'sql2']) await q(s, `IF DB_ID(N'${SCRATCH}') IS NOT NULL DROP DATABASE ${SCRATCH};`).catch(() => {});
        await q('sql2', `ALTER DATABASE model SET RECOVERY ${modelWas};`).catch(() => {});
    }
});

test('9. paired servers manage new databases by themselves, and stop managing dropped ones', async () => {
    const [A, B] = ['ItTenantA', 'ItTenantB'];
    const dbByName = async (name) => (await api.get('/api/databases')).find((d) => d.name === name);
    const before = new Set((await api.get('/api/databases')).map((d) => d.id));
    const exists = async (server, name) => (await q(server, 'SELECT COUNT(*) AS n FROM sys.databases WHERE name=@name;', { name }))[0].n === 1;
    try {
        // sql1 ships to sql2; sql2 has no target yet, so it is paired back to sql1.
        const preview = await api.get(`/api/servers/${ids.sql1}/auto-manage-preview?ship_to=${ids.sql2}`);
        assert.equal(preview.paired?.name, 'sql2');
        const saved = await api.put(`/api/servers/${ids.sql1}/auto-manage`, { auto_manage: true, ship_to_server_id: ids.sql2 });
        assert.equal(saved.paired, 'sql2');
        const sql2 = await api.get(`/api/servers/${ids.sql2}`);
        assert.deepEqual([sql2.auto_manage, sql2.ship_to_server_id], [true, ids.sql1]);
        await assert.rejects(api.put(`/api/servers/${ids.sql1}/auto-manage`, { auto_manage: true, ship_to_server_id: ids.sql1 }), (err) => err.status === 400);

        // A new database in FULL recovery on each server: managed, with a secondary on the other one.
        await q('sql1', `CREATE DATABASE ${A}; ALTER DATABASE ${A} SET RECOVERY FULL;`);
        await q('sql2', `CREATE DATABASE ${B}; ALTER DATABASE ${B} SET RECOVERY FULL;`);
        for (const [name, primary, secondary] of [[A, 'sql1', 'sql2'], [B, 'sql2', 'sql1']]) {
            await waitFor(`${name} to be shipped to ${secondary}`, async () => {
                const d = await dbByName(name);
                return d?.primary?.server_name === primary && d.replicas.some((r) => r.server_name === secondary && r.role === 'secondary' && r.chain_state === 'ok');
            }, { timeout: 300_000, interval: 3000 });
            assert.equal(await (async () => (await q(secondary, 'SELECT state_desc AS s FROM sys.databases WHERE name=@name;', { name }))[0]?.s)(), 'RESTORING');
        }

        // Dropped on sql1: no alert while it is gone, then no longer managed, and its copy on sql2 is dropped.
        const a = await dbByName(A);
        const files = (await api.get(`/api/databases/${a.id}/backups`)).filter((f) => f.file_status === 'present');
        assert.ok(files.length > 0);
        await q('sql1', `ALTER DATABASE ${A} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${A};`);
        await waitFor(`${A} to be reported gone`, async () => (await api.get('/api/events?limit=50')).some((e) => e.message?.includes(`${A} is gone from sql1`)), { timeout: 60_000, interval: 2000 });
        await sleep(8000); // longer than the alert debounce
        assert.ok(!(await api.get('/api/alerts?status=active')).some((x) => x.database_id === a.id), 'no alert while it is gone');
        await waitFor(`${A} to stop being managed`, async () => !(await dbByName(A)), { timeout: 120_000, interval: 2000 });
        assert.equal(await exists('sql2', A), false, 'its copy on sql2 was dropped');
        assert.ok(!(await api.get('/api/alerts?status=active')).some((x) => x.database_id === a.id), 'no alert');
        // Its backup files stay until retention removes them.
        for (const f of files.slice(0, 3)) {
            const [r] = await q('sql1', 'EXEC master.dbo.xp_fileexist @path;', { path: `/var/opt/mssql/backup/${f.rel_path}` });
            assert.equal(r['File Exists'], 1, f.rel_path);
        }
        // Stopped by a drop, not by a person: created again, it is managed again.
        await q('sql1', `CREATE DATABASE ${A}; ALTER DATABASE ${A} SET RECOVERY FULL;`);
        await waitFor(`${A} to be managed again`, async () => (await dbByName(A))?.primary?.server_name === 'sql1', { timeout: 120_000, interval: 3000 });
    } finally {
        for (const s of ['sql1', 'sql2']) await api.put(`/api/servers/${ids[s]}/auto-manage`, { auto_manage: false }).catch(() => {});
        for (const d of await api.get('/api/databases')) {
            if (before.has(d.id)) continue;
            for (const r of d.replicas.filter((x) => x.role !== 'primary')) {
                await api.post(`/api/databases/${d.id}/replicas/${r.server_id}/remove`, { confirm: d.name }).catch(() => {});
            }
            await api.post(`/api/databases/${d.id}/unmanage`, { confirm: d.name }).catch(() => {});
        }
        for (const s of ['sql1', 'sql2']) {
            for (const name of [A, B]) await q(s, `IF DB_ID(N'${name}') IS NOT NULL DROP DATABASE ${name};`).catch(() => {});
        }
    }
});
