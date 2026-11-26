// Starting and stopping management of a database: by a person (POST
// /api/databases), by automatic management (engine/auto-manage.js), and when
// a database was dropped on its server.
import * as databases from '../store/repos/databases.js';
import * as serversRepo from '../store/repos/servers.js';
import * as forks from '../store/repos/forks.js';
import * as events from '../store/repos/events.js';
import * as settings from '../store/repos/settings.js';
import * as inspect from '../sql/inspect.js';
import * as P from '../sql/privileged.js';
import * as health from './health.js';
import { sqlErrorText } from '../sql/pool.js';
import { startBackup } from './backup.js';
import { tryAcquire } from './locks.js';
import { publish } from '../bus.js';
import { manageKind, dbLabel, MASTER_ID } from './backup-rules.js';
import { effectiveRetention, globalRetention } from './retention-rules.js';

function fail(status, message) {
    return Object.assign(new Error(message), { status, expose: true });
}

/**
 * Starts managing a database on a server, which becomes its primary. A system
 * database, or one not in FULL recovery, is managed as backups only, on this
 * server (engine/backup-rules.js); any other is log shipped. A FULL backup
 * starts its chain right away.
 *   trigger: 'manage' (a person) or 'auto' (automatic management)
 *   autoSeed: give it a secondary on its server's default target once that FULL is there
 *   actor: the user who asked for it (NULL for automatic management)
 * Returns { db, operation, warning } (warning: the first FULL could not start).
 */
export async function manageDatabase({ serverId, name, trigger = 'manage', autoSeed = false, actor = null }) {
    const server = serversRepo.get(serverId);
    if (!server) throw fail(404, 'Server not found');
    // A log-shipped name is one database on every server.
    if (databases.find(name)?.status === 'managed') throw fail(409, `${name} is already managed`);

    let state;
    try {
        state = await inspect.dbBackupStateStarted(serverId, name);
    } catch (err) {
        throw fail(503, `Cannot reach ${server.name}: ${sqlErrorText(err)}`);
    }
    if (!state) throw fail(404, `Database ${name} does not exist on ${server.name}`);
    if (state.databaseId === 2) throw fail(409, 'Mostly-On never backs up tempdb: SQL Server creates it again at every start.');
    if (state.isSnapshot) throw fail(409, `${name} on ${server.name} is a database snapshot, which cannot be backed up.`);
    if (state.state === 'RECOVERING') throw fail(409, `Database ${name} is still starting up (RECOVERING) on ${server.name}. Try again in a moment.`);
    if (state.state !== 'ONLINE') throw fail(409, `Database ${name} is ${state.state} on ${server.name}`);

    const realName = state.name; // the server's own spelling, as health checks report it
    const backupOnly = manageKind({ databaseId: state.databaseId, recoveryModel: state.recoveryModel }) === 'backup_only';
    if (databases.find(realName)?.status === 'managed') throw fail(409, `${realName} is already managed`);
    if (databases.find(realName, serverId)?.status === 'managed') {
        throw fail(
            409,
            backupOnly
                ? `${realName} on ${server.name} is already managed`
                : `${realName} on ${server.name} is managed as backups only. To log ship it, stop managing it first, then manage it again.`,
        );
    }

    const db = databases.manage({
        name: realName,
        familyGuid: state.familyGuid,
        primaryServerId: serverId,
        backupOnly,
        fullOnly: state.databaseId === MASTER_ID,
        autoSeed: autoSeed && !backupOnly,
    });
    forks.reset(db.id, state.recoveryForkGuid);
    databases.noteOwner(db.id, state);
    const how = trigger === 'auto' ? ' (automatic management)' : '';
    events.add(
        'info',
        'database',
        backupOnly
            ? `Started backing up ${realName} on ${server.name}${how} (backups only: no secondaries, no restores)`
            : `Started managing ${realName} with primary ${server.name}${how}`,
        { databaseId: db.id, serverId, actor },
    );
    publish('database.changed', { databaseId: db.id });

    let operation = null;
    let warning = null;
    try {
        const started = await startBackup(db.id, 'FULL', { trigger: 'manage', actor });
        operation = started.operation;
    } catch (err) {
        warning = `Initial FULL backup could not start: ${err.message}`;
    }
    return { db, operation, warning };
}

/** "FULL 28, DIFF 14 and LOG 7 days", the retention that now applies to a database's backups. */
function retentionWords(db) {
    const r = effectiveRetention(db, globalRetention(settings.all()));
    return `FULL ${r.full}, DIFF ${r.diff} and LOG ${r.log} days`;
}

/**
 * Stops managing a database that was dropped on its primary. Its copies on
 * other servers are dropped when nobody can write to them (RESTORING or
 * STANDBY) and their server is reachable; any other copy is left as it is.
 * The backup files stay until retention removes them.
 * Returns false (and changes nothing) while another operation holds the database.
 */
export async function stopManagingDropped(db, primaryName) {
    const release = tryAcquire(db.id, 'exclusive');
    if (!release) return false;
    try {
        const notes = [];
        for (const r of databases.replicas(db.id).filter((x) => x.role !== 'primary')) {
            const reachable = health.getHealth(r.server_id)?.ok;
            const live = reachable ? health.dbState(r.server_id, db.name) : null;
            if (!reachable) notes.push(`Left its copy on ${r.server_name}, which is unreachable: drop it there by hand.`);
            else if (live && (live.state === 'RESTORING' || live.isInStandby)) {
                try {
                    await P.run(r.server_id, P.dropDatabase({ db: db.name }), { timeoutMs: 120_000 });
                    notes.push(`Dropped its copy on ${r.server_name}.`);
                } catch (err) {
                    notes.push(`Could not drop its copy on ${r.server_name} (${sqlErrorText(err)}): drop it there by hand.`);
                }
            } else if (live) notes.push(`Left its copy on ${r.server_name}, which is ${live.state} and could be in use.`);
            databases.removeReplica(db.id, r.server_id);
            publish('replica.changed', { databaseId: db.id, serverId: r.server_id });
        }
        databases.unmanage(db.id, { stoppedBy: 'dropped' });
        events.add(
            'warn',
            'database',
            `Stopped managing ${dbLabel(db)}: it was dropped on ${primaryName}. ${notes.join(' ')} Its backups are kept for ${retentionWords(db)} (retention).`.replace(/\s+/g, ' '),
            { databaseId: db.id },
        );
        publish('database.changed', { databaseId: db.id });
        return true;
    } finally {
        release();
    }
}
