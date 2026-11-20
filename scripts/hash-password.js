// Prints an ADMIN_PASSWORD_HASH value for the given password.
// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- 'secret' (argument; ends up in shell history)
import readline from 'node:readline';
import { hashPassword } from '../src/crypto.js';

async function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide typed characters.
    rl._writeToOutput = (s) => {
        if (s.startsWith(question)) process.stdout.write(question);
    };
    return new Promise((resolve) =>
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        }),
    );
}

let password = process.argv[2];
if (!password) {
    if (!process.stdin.isTTY) {
        password = (await new Promise((r) => {
            let d = '';
            process.stdin.on('data', (c) => (d += c)).on('end', () => r(d));
        })).replace(/\r?\n$/, '');
    } else {
        password = await prompt('Password: ');
        const again = await prompt('Repeat:   ');
        if (password !== again) {
            console.error('Passwords do not match');
            process.exit(1);
        }
    }
}
if (!password || password.length < 8) {
    console.error('Use a password of at least 8 characters');
    process.exit(1);
}
console.log(await hashPassword(password));
