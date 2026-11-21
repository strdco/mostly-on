// The setup script (sql/mostly-on-helpers.sql) with one server's values filled
// in, for the Servers page's "Download setup script". The template uses sqlcmd
// variables, $(Name); every one of them sits inside an N'...' literal, so values
// only need their single quotes doubled.
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'sql', 'mostly-on-helpers.sql');

export function setupScriptFor(server, { now = new Date() } = {}) {
    const values = {
        ServiceLogin: server.username,
        BackupRoot: server.sql_backup_root,
        StandbyRoot: server.standby_root || 'default',
        FallbackOwner: 'sa',
    };
    const text = fs.readFileSync(TEMPLATE, 'utf8').replace(/\$\((\w+)\)/g, (m, name) => (name in values ? String(values[name]).replace(/'/g, "''") : m));
    const header =
        `-- Mostly-On setup script for server ${server.name} (${server.instance_name ? `${server.host}\\${server.instance_name}` : `${server.host}:${server.port}`}), generated ${now.toISOString()}.\n` +
        `-- Run it on that server as a member of sysadmin (SSMS, Azure Data Studio or sqlcmd).\n\n`;
    return header + text;
}
