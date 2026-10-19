// Starts a real Sophia server for integration tests: a free port, a throwaway
// database, and no AI model (LLM_DISABLED=1, no keys, no .env), so answers
// come from the retrieval-only path and nothing is spent.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../server/store.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

/**
 * @param {{ env?: object, seed?: (store) => void }} opts  seed runs on the empty database before the server opens it
 * @returns {Promise<{ url: string, port: number, stop: () => Promise<void>, output: () => string }>}
 */
export async function startServer({ env = {}, seed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-it-'));
  const db = join(dir, 'sophia.db');
  if (seed) { const s = openStore(db); seed(s); s.close(); }
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), HOST: '127.0.0.1', SOPHIA_DB: db, CHAT_LOG: join(dirname(db), 'chat.jsonl'),
      LLM_DISABLED: '1', BACKUP_DISABLED: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((ok) => child.once('exit', ok));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited during startup:\n${out}`);
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start in time:\n${out}`); }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    url, port, db,
    output: () => out,
    async stop() {
      if (child.exitCode == null) { child.kill(); await exited; }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** POST /api/chat and collect the SSE events as [event, data] pairs. */
export async function chat(url, body, { user } = {}) {
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Sophia-User': user } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, headers: res.headers, json: JSON.parse(text), events: [] };
  const events = text.split('\n\n').filter(Boolean).map((raw) => {
    const ev = /^event: (.*)$/m.exec(raw)?.[1];
    const data = /^data: (.*)$/m.exec(raw)?.[1];
    return [ev, data && JSON.parse(data)];
  });
  return { status: res.status, headers: res.headers, events };
}
