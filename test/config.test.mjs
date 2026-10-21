// Covers: Server settings read from the environment: defaults, numbers, the model effort level, turning the AI and the backup provider off, and the deployed defaults (address, database, where files go).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CONFIG = new URL('../server/config.mjs', import.meta.url).href;

/** Load config in a clean child process with only these variables set. */
function load(env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(CONFIG)}).then(({ config }) => process.stdout.write(JSON.stringify(config)), (e) => { process.stderr.write(e.message); process.exit(3); })`],
  { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return r.status === 0 ? { config: JSON.parse(r.stdout) } : { error: r.stderr };
}

test('defaults with an empty environment', () => {
  const { config } = load();
  assert.equal(config.PORT, 8787);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.SITE_NAME, 'BetterCare');
  assert.equal(config.ANTHROPIC_EFFORT, 'low');
  assert.equal(config.REWRITE_MODEL, config.ANTHROPIC_MODEL, 'the rewrite uses the answer model unless told');
  assert.equal(config.LLM_ENABLED, true);
  assert.equal(config.BACKUP_ENABLED, true);
  assert.equal(config.LLM_PRIMARY, 'claude');
  assert.equal(config.REFUSAL_FALLBACK, true);
  assert.equal(config.RETRIEVAL_TOP_K, 8);
  assert.equal(config.LOW_CONFIDENCE_THRESHOLD, 0.69);
  assert.match(config.DB_FILE, /data\/sophia\.db$/);
  assert.equal(config.ADMIN_USERNAME, 'admin', 'ADMIN_PASSWORD alone creates the admin account "admin"');
});

test('HOST: every interface when deployed (Cloud Run, GKE, App Engine, the Docker image), this machine only elsewhere; HOST wins', () => {
  assert.equal(load({ K_SERVICE: 'sophia' }).config.HOST, '0.0.0.0');
  assert.equal(load({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }).config.HOST, '0.0.0.0');
  assert.equal(load({ GAE_SERVICE: 'default' }).config.HOST, '0.0.0.0');
  assert.equal(load({ NODE_ENV: 'production' }).config.HOST, '0.0.0.0');
  assert.equal(load({ K_SERVICE: 'sophia', HOST: '127.0.0.1' }).config.HOST, '127.0.0.1');
});

test('deployed: Firestore, port 8787, writes only under the temp folder, site export at /data/site; empty values mean these defaults', () => {
  for (const env of [{ K_SERVICE: 'sophia' }, { NODE_ENV: 'production', DATABASE: '', SITE_DIR: '', CHAT_LOG: '' }]) {
    const { config } = load(env);
    assert.equal(config.PORT, 8787);
    assert.equal(config.DATABASE, 'firestore');
    assert.equal(config.SITE_DIR, '/data/site');
    assert.equal(config.CHAT_LOG, '-', 'logs go to standard output');
    assert.match(config.DB_FILE, /\/sophia\/sophia\.db$/);
    assert.ok(!config.DB_FILE.includes('/data/'), 'the SQLite file, if chosen, is in the temp folder');
    assert.ok(!config.TEST_RESULTS_DIR.includes('/data/'), 'test results go to the temp folder');
  }
  assert.equal(load({ K_SERVICE: 'sophia', DATABASE: 'sqlite' }).config.DATABASE, 'sqlite', 'DATABASE wins');
});

test('on a laptop: SQLite and everything under data/; the model cache is .models/ everywhere', () => {
  const { config } = load();
  assert.equal(config.DATABASE, 'sqlite');
  assert.match(config.SITE_DIR, /data\/site$/);
  assert.match(config.CHAT_LOG, /data\/logs\/chat\.jsonl$/);
  assert.match(config.MODEL_CACHE_DIR, /\.models$/);
  assert.match(load({ K_SERVICE: 'sophia' }).config.MODEL_CACHE_DIR, /\.models$/);
});

test('numbers are read from the environment; an empty value means the default', () => {
  assert.equal(load({ PORT: '9000' }).config.PORT, 9000);
  assert.equal(load({ RETRIEVAL_TOP_K: '12', MAX_TOKENS: '100' }).config.RETRIEVAL_TOP_K, 12);
  assert.equal(load({ PORT: '' }).config.PORT, 8787);
  assert.equal(load({ LOW_CONFIDENCE_THRESHOLD: '0.5' }).config.LOW_CONFIDENCE_THRESHOLD, 0.5);
});

test('a setting that should be a number but is not stops the server with a clear message', () => {
  const { error } = load({ PORT: 'eighty' });
  assert.match(error, /PORT must be a number, got "eighty"/);
});

test('ANTHROPIC_EFFORT must be one of the known levels', () => {
  assert.equal(load({ ANTHROPIC_EFFORT: 'high' }).config.ANTHROPIC_EFFORT, 'high');
  assert.match(load({ ANTHROPIC_EFFORT: 'turbo' }).error, /ANTHROPIC_EFFORT must be one of low, medium, high, xhigh, max/);
});

test('switches: AI off, backup off, OpenAI first, refusal fallback off', () => {
  const { config } = load({ LLM_DISABLED: '1', BACKUP_DISABLED: '1', LLM_PRIMARY: 'openai', REFUSAL_FALLBACK: '0' });
  assert.deepEqual([config.LLM_ENABLED, config.BACKUP_ENABLED, config.LLM_PRIMARY, config.REFUSAL_FALLBACK], [false, false, 'openai', false]);
  assert.equal(load({ LLM_PRIMARY: 'something' }).config.LLM_PRIMARY, 'claude', 'anything else means Claude');
});

test('model, rewrite model and database file can be set', () => {
  const { config } = load({ ANTHROPIC_MODEL: 'claude-a', SOPHIA_DB: '/tmp/x.db' });
  assert.equal(config.REWRITE_MODEL, 'claude-a');
  assert.equal(config.DB_FILE, '/tmp/x.db');
  assert.equal(load({ ANTHROPIC_MODEL: 'claude-a', REWRITE_MODEL: 'claude-b' }).config.REWRITE_MODEL, 'claude-b');
});

test('the settings object cannot be changed at run time', async () => {
  const { config } = await import('../server/config.mjs');
  assert.ok(Object.isFrozen(config));
});
