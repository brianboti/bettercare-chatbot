#!/usr/bin/env node
// Sign-in accounts for the demo sign-in (AUTH_MODE=password).
//
//   npm run users -- list
//   npm run users -- add <username> [--name "Pat Lee"] [--role nurse] [--admin]
//   npm run users -- password <username>        new password for an account
//   npm run users -- admin <username> on|off
//
// Uses the database DATABASE names, so on GCP run it with the deployment's
// settings (DATABASE=firestore, FIRESTORE_PROJECT_ID, and Google credentials
// from `gcloud auth application-default login`). The password is read from
// SOPHIA_PASSWORD, or asked for without echoing it.

import { createInterface } from 'node:readline';
import { openConfiguredStore, describeDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { ROLES } from '../server/topics.mjs';

const [cmd, username, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: npm run users -- list | add <username> [--name "…"] [--role <role>] [--admin] | password <username> | admin <username> on|off');
  process.exit(2);
}

/** The password from SOPHIA_PASSWORD, or typed at a prompt that doesn't echo. */
async function readPassword() {
  if (process.env.SOPHIA_PASSWORD) return process.env.SOPHIA_PASSWORD;
  if (!process.stdin.isTTY) usage('Set SOPHIA_PASSWORD, or run this in a terminal to type the password.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (/Password/.test(s)) rl.output.write(s); };
  const pw = await new Promise((ok) => rl.question('Password (8+ characters): ', ok));
  rl.close();
  process.stdout.write('\n');
  return pw;
}

if (!cmd) usage();
const store = await openConfiguredStore();
const auth = createAuth(store);
try {
  if (cmd === 'list') {
    for (const u of await store.listUsers()) {
      if (u.demo && !(await store.getPasswordHash(u.id))) continue;
      const pw = await store.getPasswordHash(u.id) ? 'password' : 'no password';
      console.log(`${u.id.padEnd(28)} ${(u.name || '').padEnd(24)} ${(u.role || '').padEnd(10)} ${u.isAdmin ? 'admin' : ''} ${pw}${u.demo ? ' (demo)' : ''}`);
    }
  } else if (cmd === 'add') {
    if (!username) usage('Which username?');
    const role = flag('role');
    if (role && !ROLES[role]) usage(`Unknown role "${role}". Roles: ${Object.keys(ROLES).join(', ')}`);
    const fields = { ...(flag('name') ? { name: flag('name') } : {}), ...(role ? { role } : {}), ...(rest.includes('--admin') ? { isAdmin: true } : {}) };
    const u = await auth.setPassword(username, await readPassword(), fields);
    console.log(`saved ${u.id}${u.isAdmin ? ' (admin)' : ''} in ${describeDatabase()}`);
  } else if (cmd === 'password') {
    if (!username || !(await store.getUser(username))) usage(`No account "${username}".`);
    await auth.setPassword(username, await readPassword());
    const ended = await store.deleteUserSessions(username.toLowerCase());
    console.log(`password changed for ${username}; signed out of ${ended} session${ended === 1 ? '' : 's'}`);
  } else if (cmd === 'admin') {
    const on = rest[0] === 'on' ? true : rest[0] === 'off' ? false : usage('admin <username> on|off');
    if (!(await store.getUser(username))) usage(`No account "${username}".`);
    await store.saveUser(username, { isAdmin: on });
    console.log(`${username} is ${on ? 'now an admin' : 'no longer an admin'}`);
  } else {
    usage(`Unknown command "${cmd}".`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await store.close();
}
