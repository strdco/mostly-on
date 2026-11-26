// Audit/event log. Every event is also written to stdout and published on the
// bus; events that ask for it are also copied to the SQL Server error log.
import { getDb, nowIso } from '../db.js';
import { log } from '../../log.js';
import { publish } from '../../bus.js';
import { createdByOf } from './operations.js';

let errorLogWriter = null;

/**
 * Sets the function that copies an event to the error log of a SQL Server
 * (main.js wires it to the helper procedure). It must not throw and should
 * not be awaited by callers: the copy is best effort.
 * @param {((serverId:number, text:string) => Promise<void>) | null} fn
 */
export function setErrorLogWriter(fn) {
    errorLogWriter = fn;
}

/** The line written to the SQL Server error log for an event. */
export function errorLogText(event) {
    const by = event.actor ? `by ${event.actor}` : 'by Mostly-On';
    return `${event.message} (${by}${event.operationId ? `, operation #${event.operationId}` : ''})`;
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} category e.g. 'server', 'backup', 'restore', 'failover', 'auth'
 * @param {string} message
 * @param {{databaseId?:number, serverId?:number, operationId?:number, data?:object, actor?:string|null, errorLog?:(number|null|undefined)[]}} [refs]
 *   actor: the user who did it; when left out, the user who started operationId (if any).
 *   NULL means Mostly-On itself.
 *   errorLog: servers whose SQL Server error log gets a copy (key actions only).
 */
export function add(level, category, message, refs = {}) {
    const ts = nowIso();
    const { databaseId = null, serverId = null, operationId = null, data = null } = refs;
    const actor = refs.actor ?? (operationId ? createdByOf(operationId) : null);
    const info = getDb()
        .prepare(
            `INSERT INTO events (ts, level, category, database_id, server_id, operation_id, actor, message, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ts, level, category, databaseId, serverId, operationId, actor, message, data ? JSON.stringify(data) : null);
    const event = { id: Number(info.lastInsertRowid), ts, level, category, databaseId, serverId, operationId, actor, message, data };
    const fields = { category };
    if (actor) fields.actor = actor;
    if (databaseId) fields.databaseId = databaseId;
    if (serverId) fields.serverId = serverId;
    if (operationId) fields.operationId = operationId;
    if (data) fields.data = data;
    log[level](message, fields);
    publish('event', event);
    if (refs.errorLog?.length && errorLogWriter) {
        const text = errorLogText(event);
        for (const id of new Set(refs.errorLog.filter(Boolean))) errorLogWriter(id, text);
    }
    return event;
}

/**
 * @param {{databaseId?:number, serverId?:number, operationId?:number, peopleOnly?:boolean, limit?:number, beforeId?:number}} [f]
 *   peopleOnly: only what a user did (the audit trail), not what Mostly-On did by itself.
 */
export function list({ databaseId, serverId, operationId, peopleOnly = false, limit = 200, beforeId } = {}) {
    const where = [];
    const args = [];
    if (peopleOnly) where.push('actor IS NOT NULL');
    if (databaseId) {
        where.push('database_id=?');
        args.push(databaseId);
    }
    if (serverId) {
        where.push('server_id=?');
        args.push(serverId);
    }
    if (operationId) {
        where.push('operation_id=?');
        args.push(operationId);
    }
    if (beforeId) {
        where.push('id<?');
        args.push(beforeId);
    }
    const sqlText = `SELECT id, ts, level, category, database_id, server_id, operation_id, actor, message, data
        FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT ?`;
    return getDb()
        .prepare(sqlText)
        .all(...args, Math.min(Math.max(1, limit | 0), 1000))
        .map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}
