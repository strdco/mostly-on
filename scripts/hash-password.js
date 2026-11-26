// Prints an ADMIN_PASSWORD_HASH value for the given password. That variable
// only creates the first user; after that, users are managed in the dashboard.
// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- 'secret' (argument; ends up in shell history)
import { hashPassword } from '../src/crypto.js';
import { readPassword } from './read-password.js';

let password;
try {
    password = await readPassword(process.argv[2]);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
if (!password || password.length < 8) {
    console.error('Use a password of at least 8 characters');
    process.exit(1);
}
console.log(await hashPassword(password));
