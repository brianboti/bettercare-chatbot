// Covers: Calls to the AI model with fake clients (no network): the search rewrite, welcome cards and streamed answers, what each request asks for, and switching to OpenAI when Claude can't be reached.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'LLM_DISABLED', 'LLM_PRIMARY', 'BACKUP_DISABLED', 'REFUSAL_FALLBACK', 'ANTHROPIC_MODEL', 'REWRITE_MODEL']) delete process.env[k];
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const llm = await import('../server/llm.mjs');
const { REWRITE_SYSTEM, SYSTEM } = await import('../server/prompt.mjs');

const usage = { input_tokens: 10, output_tokens: 5 };
const err = (Cls, status, message) => new Cls(status, { type: 'error', error: { message } }, message, new Headers());

/** A fake Anthropic client: `create` and `stream` answer from the given functions; every request is recorded. */
function fakeClaude({ create = () => reply('{}'), stream = () => streamOf([]) } = {}) {
  const requests = [];
  return {
    requests,
    beta: { messages: {
      create: async (req) => { requests.push(req); return create(req); },
      stream: (req, opts) => { requests.push({ ...req, _opts: opts }); return stream(req); },
    } },
  };
}
const reply = (text, extra = {}) => ({ model: 'claude-opus-5', usage, stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });

/** A fake Claude stream of events; `fail` is thrown after the events. */
function streamOf(events, { fail = null, final = { stop_reason: 'end_turn', model: 'claude-opus-5', usage, stop_details: null } } = {}) {
  return {
    async* [Symbol.asyncIterator]() { for (const e of events) yield e; if (fail) throw fail; },
    finalMessage: async () => final,
  };
}
const delta = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

/** A fake OpenAI client for the backup. */
function fakeOpenAI({ json = '{}', deltas = ['backup'] } = {}) {
  const requests = [];
  return {
    requests,
    responses: { create: async (req) => {
      requests.push(req);
      if (!req.stream) return { status: 'completed', output_text: json, model: 'gpt-5.4-mini', usage: { input_tokens: 3, output_tokens: 2 } };
      return (async function* () {
        for (const d of deltas) yield { type: 'response.output_text.delta', delta: d };
        yield { type: 'response.completed', response: { status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 3, output_tokens: 2 } } };
      })();
    } },
  };
}

let usageSeen;
beforeEach((t) => {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[k];
  llm._setClientsForTest();
  usageSeen = [];
  llm.onUsage((u) => usageSeen.push(u));
  t.mock.method(console, 'warn', () => {});
});

// ---------------------------------------------------------------- which provider

test('the model is available with a Claude key, a Claude token, or an OpenAI key', () => {
  assert.equal(llm.llmAvailable(), false);
  process.env.ANTHROPIC_AUTH_TOKEN = 't';
  assert.equal(llm.llmAvailable(), true);
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.OPENAI_API_KEY = 'k';
  assert.equal(llm.llmAvailable(), true);
});

test('providers: Claude first with OpenAI as backup, whichever keys exist', () => {
  assert.deepEqual(llm.providers(), { primary: null, backup: null, claudeSkippedUntil: null });
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.deepEqual(llm.providers(), { primary: 'claude', backup: null, claudeSkippedUntil: null });
  process.env.OPENAI_API_KEY = 'k';
  assert.deepEqual(llm.providers(), { primary: 'claude', backup: 'openai', claudeSkippedUntil: null });
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(llm.providers(), { primary: 'openai', backup: null, claudeSkippedUntil: null });
});

test('settings: LLM_DISABLED turns the model off; LLM_PRIMARY=openai asks OpenAI first', () => {
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const l = await import(${JSON.stringify(new URL('../server/llm.mjs', import.meta.url).href)}); console.log(JSON.stringify({ on: l.llmAvailable(), p: l.providers() }))`],
  { env: { PATH: process.env.PATH, ...env }, cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString());
  assert.equal(run({ LLM_DISABLED: '1', ANTHROPIC_API_KEY: 'k' }).on, false);
  assert.deepEqual(run({ LLM_PRIMARY: 'openai', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }).p, { primary: 'openai', backup: null, claudeSkippedUntil: null });
  assert.equal(run({ BACKUP_DISABLED: '1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }).p.backup, null);
});

// ---------------------------------------------------------------- rewrite

test('rewrite: sends the facts, the person and the conversation, and reads back a clean query', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  const claude = fakeClaude({ create: () => reply(JSON.stringify({
    query: 'Haiku install steps\nsecond line', topics: ['Haiku & Canto', 'Not a topic'], intent: 'howto',
    context: ['  using an iPhone  ', 'x'.repeat(200), '', 'a', 'b', 'c', 'd', 'e'],
  })) });
  llm._setClientsForTest({ anthropic: claude });
  const history = [{ role: 'user', content: 'q'.repeat(2000) }, { role: 'assistant', content: 'Sure.' }];
  const out = await llm.rewriteQuery(history, 'and on my phone?', 'FACTS', 'Role: Nurse', { userId: 'u1' });

  assert.equal(out.query, 'Haiku install steps');
  assert.deepEqual(out.topics, ['Haiku & Canto']);
  assert.equal(out.intent, 'howto');
  assert.deepEqual(out.context, ['using an iPhone', 'x'.repeat(80), 'a', 'b', 'c', 'd']);

  const [req] = claude.requests;
  assert.equal(req.system, REWRITE_SYSTEM);
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  const content = req.messages[0].content;
  assert.match(content, /<site_facts>\nFACTS\n<\/site_facts>/);
  assert.match(content, /<person>\nRole: Nurse\n<\/person>/);
  assert.match(content, /User: q{1500}\nAssistant: Sure\./);
  assert.match(content, /Latest message: and on my phone\?$/);
  assert.deepEqual(usageSeen, [{ purpose: 'rewrite', model: 'claude-opus-5', usage, userId: 'u1' }]);
});

test('rewrite: a first message says so, and a refusal or unreadable reply falls back to the question itself', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  for (const r of [reply('{}', { stop_reason: 'refusal' }), reply('not json')]) {
    const claude = fakeClaude({ create: () => r });
    llm._setClientsForTest({ anthropic: claude });
    assert.deepEqual(await llm.rewriteQuery([], 'Where is the help desk?'), { query: 'Where is the help desk?', topics: [], intent: null, context: [] });
    assert.match(claude.requests[0].messages[0].content, /^<conversation>\n\(no earlier messages\)/);
  }
});

test('quick calls: thinking and effort settings fit each model', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  const claude = fakeClaude();
  llm._setClientsForTest({ anthropic: claude });
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5']) await llm.rewriteQuery([], 'q', '', '', { model });
  const [haiku, sonnet, opus55, opus5] = claude.requests;
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
  assert.equal(haiku.output_config.effort, undefined, 'Haiku 4.5 has no effort setting');
  assert.equal(haiku.betas, undefined, 'no refusal fallback on Haiku');
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' });
  assert.equal(sonnet.output_config.effort, 'low');
  assert.equal(opus55.thinking, undefined, "Opus 5.5 can't turn thinking off");
  assert.equal(opus55.output_config.effort, 'low');
  assert.deepEqual(opus5.thinking, { type: 'disabled' });
  for (const r of [sonnet, opus55, opus5]) assert.deepEqual([r.betas, r.fallbacks], [['server-side-fallback-2026-07-01'], 'default']);
});

// ---------------------------------------------------------------- generateJson

test('structured calls return the parsed JSON, or null when cut off or unreadable', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  let next = reply('{"greeting":"Hi"}');
  const claude = fakeClaude({ create: () => next });
  llm._setClientsForTest({ anthropic: claude });
  assert.deepEqual(await llm.generateJson('SYS', 'content', { type: 'object' }, { purpose: 'welcome', userId: 'u', maxTokens: 99 }), { greeting: 'Hi' });
  assert.equal(claude.requests[0].max_tokens, 99);
  assert.equal(claude.requests[0].system, 'SYS');
  assert.equal(usageSeen[0].purpose, 'welcome');
  next = reply('{"greeting":"Hi"', { stop_reason: 'max_tokens' });
  assert.equal(await llm.generateJson('S', 'c', {}), null);
  next = reply('nope');
  assert.equal(await llm.generateJson('S', 'c', {}), null);
});

// ---------------------------------------------------------------- answers

test('answers stream text as it arrives, reset on a fallback model, and cache the system prompt', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  const claude = fakeClaude({ stream: () => streamOf([
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    delta('Hello'),
    { type: 'content_block_start', content_block: { type: 'fallback' } },
    delta(' world'),
  ], { final: { stop_reason: 'end_turn', model: 'claude-opus-4-8', usage, stop_details: { x: 1 } } }) });
  llm._setClientsForTest({ anthropic: claude });
  const text = [];
  let resets = 0;
  const signal = new AbortController().signal;
  const out = await llm.streamAnswer([{ role: 'user', content: 'hi' }], { onText: (t) => text.push(t), onReset: () => resets++ }, signal, { userId: 'u' });

  assert.deepEqual(text, ['Hello', ' world']);
  assert.equal(resets, 1);
  assert.deepEqual(out, { stopReason: 'end_turn', model: 'claude-opus-4-8', usage, stopDetails: { x: 1 } });
  const [req] = claude.requests;
  assert.deepEqual(req.system, [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req._opts.signal, signal);
  assert.deepEqual(usageSeen.map((u) => [u.purpose, u.userId]), [['answer', 'u']]);
});

// ---------------------------------------------------------------- the backup

test('a Claude billing or key problem switches to OpenAI, and Claude is skipped for a while', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.OPENAI_API_KEY = 'k';
  const claude = fakeClaude({ create: () => { throw err(Anthropic.AuthenticationError, 401, 'invalid x-api-key'); } });
  const openai = fakeOpenAI({ json: '{"query":"from openai","topics":[],"intent":null,"context":[]}' });
  llm._setClientsForTest({ anthropic: claude, openai });

  assert.equal((await llm.rewriteQuery([], 'q')).query, 'from openai');
  assert.equal(claude.requests.length, 1);
  assert.ok(llm.providers().claudeSkippedUntil, 'cool-down shown on /api/health');
  assert.deepEqual(usageSeen.map((u) => u.model), ['gpt-5.4-mini']);

  await llm.rewriteQuery([], 'again');
  assert.equal(claude.requests.length, 1, 'skipped while cooling down');
  assert.equal(openai.requests.length, 2);
});

test('an answer that fails part-way restarts on OpenAI and clears the partial text first', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.OPENAI_API_KEY = 'k';
  const claude = fakeClaude({ stream: () => streamOf([delta('Half an ans')], { fail: err(Anthropic.InternalServerError, 529, 'Overloaded') }) });
  const openai = fakeOpenAI({ deltas: ['Whole ', 'answer'] });
  llm._setClientsForTest({ anthropic: claude, openai });
  const seen = [];
  const out = await llm.streamAnswer([{ role: 'user', content: 'q' }], { onText: (t) => seen.push(t), onReset: () => seen.push('<reset>') }, undefined);
  assert.deepEqual(seen, ['Half an ans', '<reset>', 'Whole ', 'answer']);
  assert.equal(out.model, 'gpt-5.5');
  assert.equal(openai.requests[0].instructions, SYSTEM);
});

test('our own bugs and cancelled requests are not hidden by the backup', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.OPENAI_API_KEY = 'k';
  for (const e of [err(Anthropic.BadRequestError, 400, 'max_tokens: must be positive'), new Anthropic.APIUserAbortError()]) {
    const openai = fakeOpenAI();
    llm._setClientsForTest({ anthropic: fakeClaude({ create: () => { throw e; } }), openai });
    await assert.rejects(llm.generateJson('S', 'c', {}), e.constructor);
    assert.equal(openai.requests.length, 0);
  }
});

test('without an OpenAI key, a Claude outage is reported, not hidden', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  llm._setClientsForTest({ anthropic: fakeClaude({ create: () => { throw err(Anthropic.InternalServerError, 500, 'down'); } }) });
  await assert.rejects(llm.generateJson('S', 'c', {}), /down/);
});

test('with only an OpenAI key, OpenAI does the work', async () => {
  process.env.OPENAI_API_KEY = 'k';
  const claude = fakeClaude();
  const openai = fakeOpenAI({ json: '{"ok":true}' });
  llm._setClientsForTest({ anthropic: claude, openai });
  assert.deepEqual(await llm.generateJson('S', 'c', {}, { purpose: 'welcome' }), { ok: true });
  assert.equal(claude.requests.length, 0);
  assert.equal(openai.requests[0].text.format.name, 'welcome');
});

test('a broken usage recorder never breaks the answer', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  llm._setClientsForTest({ anthropic: fakeClaude({ create: () => reply('{"a":1}') }) });
  llm.onUsage(() => { throw new Error('disk full'); });
  assert.deepEqual(await llm.generateJson('S', 'c', {}), { a: 1 });
});
