// Periodic health checks of every registered server. Keeps the latest result
// in memory (for the API and other engine parts) and persists the essentials.
import * as serversRepo from '../store/repos/servers.js';
import * as events from '../store/repos/events.js';
import * as settings from '../store/repos/settings.js';
import * as inspect from '../sql/inspect.js';
import { sqlErrorText } from '../sql/pool.js';
import { publish } from '../bus.js';
import { log } from '../log.js';
import { MIN_MAJOR, isSupported, versionName, dataLimitBytes } from '../sqlversion.js';

const state = new Map(); // serverId -> { ok, checkedAt, error, info, databases, warnings }
let timer = null;
let running = false;

export function getHealth(serverId) {
    return state.get(serverId) || null;
}

export function allHealth() {
    return Object.fromEntries(state);
}

/** Latest known state of a database on a server, or null. */
export function dbState(serverId, dbName) {
    const h = state.get(serverId);
    return h?.ok ? h.databases.find((d) => d.name === dbName) || null : null;
}

export function forget(serverId) {
    state.delete(serverId);
}

export async function checkServer(serverId) {
    const server = serversRepo.get(serverId);
    if (!server) return null;
    const prev = state.get(serverId);
    const checkedAt = new Date().toISOString();
    let result;
    try {
        const [info, dbs] = await Promise.all([inspect.serverInfo(serverId), inspect.databases(serverId)]);
        const warnings = [];
        info.versionName = versionName(info.majorVersion);
        info.dataLimitBytes = dataLimitBytes(info.majorVersion, info.engineEdition);
        if (!isSupported(info.majorVersion)) {
            warnings.push(`${info.versionName} (${info.productVersion}) is not supported; cheap-log needs ${versionName(MIN_MAJOR)} or newer.`);
        }
        if (info.engineEdition !== 4) {
            warnings.push(`Edition is ${info.edition}, not Express. cheap-log will still work but is designed for Express.`);
        }
        result = { ok: true, checkedAt, error: null, info, databases: dbs, warnings };
        serversRepo.recordHealth(serverId, { ok: true, ...info });
    } catch (err) {
        result = { ok: false, checkedAt, error: sqlErrorText(err), info: prev?.info || null, databases: [], warnings: [] };
        serversRepo.recordHealth(serverId, { ok: false, error: result.error });
    }
    state.set(serverId, result);

    if (prev && prev.ok !== result.ok) {
        if (result.ok) events.add('info', 'server', `Server ${server.name} is reachable again`, { serverId });
        else events.add('error', 'server', `Server ${server.name} is unreachable: ${result.error}`, { serverId });
    } else if (!prev && !result.ok) {
        events.add('warn', 'server', `Server ${server.name} is unreachable: ${result.error}`, { serverId });
    }
    publish('server.health', { serverId, ok: result.ok, checkedAt });
    return result;
}

export async function checkAll() {
    const servers = serversRepo.list().filter((s) => s.enabled);
    await Promise.allSettled(servers.map((s) => checkServer(s.id)));
}

export function start() {
    const loop = async () => {
        if (running) return;
        running = true;
        try {
            await checkAll();
        } catch (err) {
            log.error('Health loop failed', { err });
        } finally {
            running = false;
        }
        timer = setTimeout(loop, settings.get('health.interval_seconds') * 1000);
        timer.unref?.();
    };
    loop();
}

export function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
}
