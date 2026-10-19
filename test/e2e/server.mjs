// Starts a throwaway Sophia server for the end-to-end tests: its own port and
// a temporary database, no AI model (retrieval-only answers, so no API spend
// and the same answer every run). The real .env is never loaded.
//
//   const srv = await startServer({ seed: (store) => store.saveUser(...) });
//   srv.url        http://127.0.0.1:<port>
//   await srv.stop()

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../server/store.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Why the end-to-end tests can't run here, or null when they can. */
export async function missingPrereq() {
  if (!existsSync(join(ROOT, 'data/site/pages'))) return 'the site export (data/site) is missing';
  if (!existsSync(join(ROOT, 'data/index/chunks.json'))) return 'the search index (data/index/chunks.json) is missing; run npm run ingest';
  try {
    const { chromium } = await import('playwright');
    if (!existsSync(chromium.executablePath())) return 'Chromium is not installed; run npx playwright install chromium';
  } catch {
    return 'Playwright is not installed; run npm install';
  }
  return null;
}

const freePort = () => new Promise((ok, fail) => {
  const s = createServer();
  s.unref();
  s.on('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/**
 * @param {{ seed?: (store) => void, timeoutMs?: number }} opts
 *   seed: writes to the temporary database before the server opens it
 */
export async function startServer({ seed, timeoutMs = 120_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-e2e-'));
  const db = join(dir, 'sophia.db');
  if (seed) { const store = openStore(db); seed(store); store.close(); }

  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', SOPHIA_DB: db, CHAT_LOG: join(dir, 'chat.jsonl'), LLM_DISABLED: '1', BACKUP_DISABLED: '1', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '' };
  delete env.NODE_TEST_CONTEXT;   // the server is not a test file
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited early:\n${output}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start in ${timeoutMs / 1000}s:\n${output}`); }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    url,
    db,
    output: () => output,
    async stop() {
      if (child.exitCode == null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
