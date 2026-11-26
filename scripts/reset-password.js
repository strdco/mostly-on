// Sets a new password for a Mostly-On user, from the command line: for when
// nobody who can log in is left (forgotten password, disabled accounts).
// The account is enabled again, and its user picks their own password at the
// next login. Without a user name, lists the users.
//
// Usage (in the container):
//   docker compose exec controller npm run reset-password -- <user>
//   docker compose exec controller npm run reset-password            (lists users)
// Locally: npm run reset-password -- <user>   (reads DATA_DIR, default ./data)
import path from 'node:path';
import { hashPassword } from '../src/crypto.js';
import { openDb, closeDb } from '../src/store/db.js';
import * as users from '../src/store/repos/users.js';
import * as sessions from '../src/store/repos/sessions.js';
import * as events from '../src/store/repos/events.js';
import { setLogLevel } from '../src/log.js';
import { readPassword } from './read-password.js';

setLogLevel('warn');
const dataDir = path.resolve(process.env.DATA_DIR || './data');
openDb(path.join(dataDir, 'mostly-on.db'));
try {
    const name = process.argv[2];
    if (!name) {
        const all = users.list();
        if (!all.length) console.log('There are no users yet. The first one is made from ADMIN_USER and ADMIN_PASSWORD_HASH when Mostly-On starts.');
        for (const u of all) console.log(`${u.username}${u.disabled_at ? ' (disabled)' : ''}`);
        console.log('\nUsage: npm run reset-password -- <user>');
    } else {
        const u = users.getByName(name);
        if (!u) {
            console.error(`There is no user named ${name}. Run without a name to list the users.`);
            process.exitCode = 1;
        } else {
            const password = await readPassword();
            users.checkTemporaryPassword(password);
            users.setPassword(u.id, await hashPassword(password), { mustChange: true });
            if (u.disabled_at) users.setDisabled(u.id, false);
            sessions.destroyForUser(u.username);
            events.add('warn', 'user', `Password of ${u.username} reset from the command line${u.disabled_at ? ', and the account enabled again' : ''}`, { actor: '(command line)' });
            console.log(`Done. ${u.username} can log in with this password, and then chooses a new one.`);
        }
    }
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
} finally {
    closeDb();
}
