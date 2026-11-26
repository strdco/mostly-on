// Reads a password: from the first argument after the command's own, from
// stdin when it is not a terminal, or typed twice with the input hidden.
import readline from 'node:readline';

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

/** argument: a password given on the command line (ends up in shell history). */
export async function readPassword(argument) {
    if (argument) return argument;
    if (!process.stdin.isTTY) {
        const text = await new Promise((r) => {
            let d = '';
            process.stdin.on('data', (c) => (d += c)).on('end', () => r(d));
        });
        return text.replace(/\r?\n$/, '');
    }
    const password = await prompt('Password: ');
    const again = await prompt('Repeat:   ');
    if (password !== again) throw new Error('Passwords do not match');
    return password;
}
