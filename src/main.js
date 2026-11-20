// cheap-log controller entry point.
//
// Startup order matters for crash safety:
//   1. config + catalog migrations
//   2. reconcile the catalog with reality (later phases)
//   3. start loops (health, schedules, restore loops, alerts)
//   4. start the HTTP server
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { openDb, closeDb } from './store/db.js';
import * as sessions from './store/repos/sessions.js';
import * as events from './store/repos/events.js';
import { initPools, closeAll as closePools } from './sql/pool.js';
import * as health from './engine/health.js';
import { createHttpServer } from './http/server.js';
import { closeAllStreams } from './http/sse.js';
import { authRoutes } from './http/routes/auth.js';
import { serverRoutes } from './http/routes/servers.js';
import { miscRoutes } from './http/routes/misc.js';

let cfg;
try {
    cfg = loadConfig();
} catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(2);
}
setLogLevel(cfg.logLevel);

openDb(path.join(cfg.dataDir, 'cheap-log.db'));
sessions.purgeExpired();
initPools(cfg.secretKeyBytes);
const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
events.add('info', 'controller', `Controller ${version} starting`, { data: { version, node: process.version } });

await health.checkAll();
health.start();

const deps = { cfg };
const server = createHttpServer(cfg, (router) => {
    authRoutes(router, deps);
    serverRoutes(router, deps);
    miscRoutes(router, deps);
});

server.listen(cfg.port, cfg.host, () => {
    log.info('HTTP server listening', { host: cfg.host, port: cfg.port, publicUrl: cfg.publicUrl });
});

let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down', { signal });
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
