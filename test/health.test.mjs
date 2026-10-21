// Covers: The health check Fast Deploy probes before and after every release: the server starts as its image does and GET /api/health answers 200.
// Drafted by Fast Deploy: checks that GET /api/health answers 200, the path the platform probes before and after every
// release. It starts the service as its image does (node server/index.mjs) on a free port and stops it afterwards; node --test
// finds it, and the platform runs it before every build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  return port;
}

test('GET /api/health answers 200', async (t) => {
  const port = await freePort();
  const service = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  t.after(() => service.kill('SIGTERM'));
  let response = null;
  for (let attempt = 0; attempt < 100 && !response; attempt += 1) {
    response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    if (!response) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(response, 'the service did not answer within 10 seconds');
  assert.equal(response.status, 200);
});
