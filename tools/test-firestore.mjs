#!/usr/bin/env node
// Runs the database, sign-in and API tests against Firestore, using Google's
// local Firestore emulator (free; nothing touches a real project).
//
//   npm run test:firestore
//
// Needs the emulator once: gcloud components install cloud-firestore-emulator
// (it runs on Java 21 or newer). If FIRESTORE_EMULATOR_HOST is already set,
// that emulator is used and left running.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8085 + Math.floor(Math.random() * 500);

let emulator = null;
let host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) {
  host = `127.0.0.1:${PORT}`;
  emulator = spawn('gcloud', ['emulators', 'firestore', 'start', `--host-port=${host}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  const ready = new Promise((ok, fail) => {
    const on = (d) => { out += d; if (/Dev App Server is now running/.test(out)) ok(); };
    emulator.stdout.on('data', on);
    emulator.stderr.on('data', on);
    emulator.once('error', (e) => fail(new Error(`Can't start the Firestore emulator (${e.message}). Install it with: gcloud components install cloud-firestore-emulator`)));
    emulator.once('exit', (code) => fail(new Error(`The Firestore emulator stopped (exit ${code}):\n${out}`)));
    setTimeout(() => fail(new Error(`The Firestore emulator did not start in 60 s:\n${out}`)), 60_000);
  });
  try { await ready; } catch (e) { console.error(e.message); process.exit(2); }
  console.log(`Firestore emulator on ${host}`);
}

const env = { ...process.env, FIRESTORE_EMULATOR_HOST: host, FIRESTORE_PROJECT_ID: 'sophia-test', TEST_DATABASE: 'firestore' };
const run = (args) => spawnSync(process.execPath, ['--test', ...args], { cwd: ROOT, env, stdio: 'inherit' }).status;
const status = run(['test/store.test.mjs', 'test/auth.test.mjs']) || run(['test/integration/api.test.mjs', 'test/integration/auth.test.mjs']);

if (emulator) {
  // gcloud starts the emulator as a child of its own; stop the whole group.
  try { process.kill(-emulator.pid, 'SIGTERM'); } catch { /* already gone */ }
}
process.exit(status ?? 1);
