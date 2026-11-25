// Mostly-On controller entry point.
//
// Startup order matters for crash safety:
//   1. config + catalog migrations
//   2. health-check every server, then reconcile the journal with reality
//   3. start loops (health, schedules, restore loops, alerts)
//   4. start the HTTP server
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { openDb, closeDb, CatalogVersionError } from './store/db.js';
import * as sessions from './store/repos/sessions.js';
import * as events from './store/repos/events.js';
import { initPools, closeAll as closePools } from './sql/pool.js';
import * as health from './engine/health.js';
import * as discovery from './engine/discovery.js';
import * as autoManage from './engine/auto-manage.js';
import * as scheduler from './engine/scheduler.js';
import * as retention from './engine/retention.js';
import * as restoreLoop from './engine/restore-loop.js';
import { replicaRoutes } from './http/routes/replicas.js';
import { failoverRoutes } from './http/routes/failover.js';
import { reconcileOnStartup } from './engine/reconcile.js';
import { setEngineConfig } from './engine/context.js';
import { createHttpServer } from './http/server.js';
import { closeAllStreams } from './http/sse.js';
import { authRoutes } from './http/routes/auth.js';
import { serverRoutes } from './http/routes/servers.js';
import { miscRoutes } from './http/routes/misc.js';
import { databaseRoutes } from './http/routes/databases.js';
import { operationRoutes } from './http/routes/operations.js';
import { alertRoutes } from './http/routes/alerts.js';
import * as notifier from './notify/notifier.js';
import { createPushover } from './notify/pushover.js';
import * as alerts from './notify/alerts.js';

let cfg;
try {
    cfg = loadConfig();
} catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(2);
}
setLogLevel(cfg.logLevel);

try {
    openDb(path.join(cfg.dataDir, 'mostly-on.db'));
} catch (err) {
    // Nothing has run yet: no schedules, no SQL. Say why and stop; the restart policy will retry.
    log.error(`Cannot open the catalog: ${err.message}`, { err });
    process.exit(err instanceof CatalogVersionError ? 3 : 2);
}
sessions.purgeExpired();
initPools(cfg.secretKeyBytes);
setEngineConfig(cfg);
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
events.add('info', 'controller', `Controller ${version} starting`, { data: { version, node: process.version } });

await health.checkAll();
await reconcileOnStartup();
health.start();
discovery.start();
autoManage.start(); // after discovery: both run after each health check, in this order
scheduler.start();
retention.start();
restoreLoop.start();
notifier.register(createPushover(cfg.pushover));
if (!notifier.anyConfigured()) log.warn('No notification channel configured (PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY); alerts are only shown in the dashboard');
alerts.start();

const deps = { cfg };
const server = createHttpServer(cfg, (router) => {
    authRoutes(router, deps);
    serverRoutes(router, deps);
    miscRoutes(router, deps);
    databaseRoutes(router, deps);
    replicaRoutes(router, deps);
    failoverRoutes(router, deps);
    operationRoutes(router, deps);
    alertRoutes(router, deps);
});

server.listen(cfg.port, cfg.host, () => {
    log.info('HTTP server listening', { host: cfg.host, port: cfg.port, publicUrl: cfg.publicUrl });
});

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down', { signal });
    alerts.stop();
    scheduler.stop();
    restoreLoop.stop();
    retention.stop();
    discovery.stop();
    health.stop();
    closeAllStreams();
    server.close();
    await closePools();
    events.add('info', 'controller', `Controller stopped (${signal})`);
    closeDb();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', { err }));
