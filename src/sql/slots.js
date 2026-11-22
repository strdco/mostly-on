// How many backups and restores run at once on one SQL Server instance.
//
// Each instance has a limit: its own (servers.max_parallel), else the
// orchestrator's default (setting servers.max_parallel). BACKUP and RESTORE
// statements over the limit wait in line, first come first served, without a
// time limit. Health checks and other short queries do not count (they have
// their own connections, sql/pool.js), and failovers and rollbacks skip the
// line (privileged.js, opts.priority): they are urgent, and they already wait
// for running work on their own database through its lock.
//
// Work still waiting gives way when its abortWhen() says so: a failover,
// rollback or reinitialization wants that database, and must not wait behind
// work that has not even started.
import * as settings from '../store/repos/settings.js';
import * as serversRepo from '../store/repos/servers.js';

const CHECK_MS = 500;
const lines = new Map(); // serverId -> { running: number, waiting: Waiter[] }

/** The instance's limit: its own value, else the orchestrator's default. */
export function limitFor(serverId) {
    return serversRepo.get(serverId)?.max_parallel ?? settings.get('servers.max_parallel');
}

function lineOf(serverId) {
    let line = lines.get(serverId);
    if (!line) {
        line = { running: 0, waiting: [] };
        lines.set(serverId, line);
    }
    return line;
}

/** What runs and waits on an instance right now (for the dashboard). */
export function slotStatus(serverId) {
    const line = lines.get(serverId);
    return { limit: limitFor(serverId), running: line?.running ?? 0, waiting: line?.waiting.length ?? 0 };
}

function grant(serverId, line) {
    line.running++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        line.running--;
        admit(serverId);
    };
}

/** Lets waiting work in, in order, while the instance has room (the limit is read every time). */
function admit(serverId) {
    const line = lines.get(serverId);
    if (!line) return;
    const limit = limitFor(serverId);
    while (line.waiting.length && line.running < limit) {
        const w = line.waiting.shift();
        clearInterval(w.timer);
        w.resolve(grant(serverId, line));
    }
    line.waiting.forEach((w, i) => w.tell(i));
}

/**
 * Waits for room on the instance; resolves with release(), to call once the
 * statement has finished.
 * @param {number} serverId
 * @param {{abortWhen?:()=>string|false|null|undefined, onWait?:(s:{running:number, limit:number, ahead:number})=>void}} [o]
 *   abortWhen: while waiting, a reason to give up (rejects with err.gaveWay = true).
 *   onWait: told when the work starts waiting and when its place in line changes.
 */
export function acquireSlot(serverId, { abortWhen = null, onWait = null } = {}) {
    const line = lineOf(serverId);
    if (!line.waiting.length && line.running < limitFor(serverId)) return Promise.resolve(grant(serverId, line));
    return new Promise((resolve, reject) => {
        let told = null;
        const w = {
            resolve,
            tell: (ahead) => {
                if (ahead === told) return;
                told = ahead;
                onWait?.({ running: line.running, limit: limitFor(serverId), ahead });
            },
        };
        // Checked regularly: a reason to give way, or a raised limit (setting or server edited).
        w.timer = setInterval(() => {
            const why = abortWhen?.();
            if (why) {
                clearInterval(w.timer);
                line.waiting.splice(line.waiting.indexOf(w), 1);
                admit(serverId);
                reject(Object.assign(new Error(typeof why === 'string' ? why : 'Gave way to more urgent work'), { gaveWay: true }));
                return;
            }
            admit(serverId);
        }, CHECK_MS);
        line.waiting.push(w);
        w.tell(line.waiting.length - 1);
    });
}

/** Test helper. */
export function _reset() {
    for (const line of lines.values()) for (const w of line.waiting) clearInterval(w.timer);
    lines.clear();
}
