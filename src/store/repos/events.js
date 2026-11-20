// Audit/event log. Every event is also written to stdout and published on the bus.
import { getDb, nowIso } from '../db.js';
import { log } from '../../log.js';
import { publish } from '../../bus.js';

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} category e.g. 'server', 'backup', 'restore', 'failover', 'auth'
 * @param {string} message
 * @param {{databaseId?:number, serverId?:number, operationId?:number, data?:object}} [refs]
 */
export function add(level, category, message, refs = {}) {
    const ts = nowIso();
    const { databaseId = null, serverId = null, operationId = null, data = null } = refs;
    const info = getDb()
        .prepare(
            `INSERT INTO events (ts, level, category, database_id, server_id, operation_id, message, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ts, level, category, databaseId, serverId, operationId, message, data ? JSON.stringify(data) : null);
    const event = { id: Number(info.lastInsertRowid), ts, level, category, databaseId, serverId, operationId, message, data };
    const fields = { category };
    if (databaseId) fields.databaseId = databaseId;
    if (serverId) fields.serverId = serverId;
    if (operationId) fields.operationId = operationId;
    if (data) fields.data = data;
    log[level](message, fields);
    publish('event', event);
    return event;
}

export function list({ databaseId, serverId, operationId, limit = 200, beforeId } = {}) {
    const where = [];
    const args = [];
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
    const sqlText = `SELECT id, ts, level, category, database_id, server_id, operation_id, message, data
        FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT ?`;
    return getDb()
        .prepare(sqlText)
        .all(...args, Math.min(Math.max(1, limit | 0), 1000))
        .map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}
