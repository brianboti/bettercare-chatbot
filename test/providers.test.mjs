// Covers: The backup provider: which Claude errors switch to OpenAI, OpenAI usage priced like Claude's, and the OpenAI calls themselves (with a fake client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { failoverReason } from '../server/llm.mjs';
import { usageOf, openaiJson, openaiStream, openaiConfigured, _setClientForTest } from '../server/openai.mjs';
import { costOfResponse, priceFor } from '../server/pricing.mjs';

const err = (Cls, status, message) => new Cls(status, { type: 'error', error: { message } }, message, new Headers());

test('account problems and outages switch to the backup; bugs and cancels do not', () => {
  assert.equal(failoverReason(err(Anthropic.BadRequestError, 400, 'Your credit balance is too low to access the Anthropic API.')), 'account');
  assert.equal(failoverReason(err(Anthropic.AuthenticationError, 401, 'invalid x-api-key')), 'account');
  assert.equal(failoverReason(err(Anthropic.InternalServerError, 529, 'Overloaded')), 'outage');
  assert.equal(failoverReason(err(Anthropic.RateLimitError, 429, 'rate limited')), 'outage');
  assert.equal(failoverReason(new Anthropic.APIConnectionError({ message: 'ECONNRESET' })), 'outage');
  // A malformed request is our bug: the backup would hide it.
  assert.equal(failoverReason(err(Anthropic.BadRequestError, 400, 'max_tokens: must be positive')), null);
  assert.equal(failoverReason(new Anthropic.APIUserAbortError()), null);
  assert.equal(failoverReason(new Error('boom')), null);
});

test('OpenAI usage: cached tokens split out, priced from its own rates', () => {
  const u = usageOf({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 400_000 }, output_tokens: 100_000 });
  assert.deepEqual(u, { input_tokens: 600_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0, output_tokens: 100_000 });
  // gpt-5.5: $5 in, $30 out, $0.50 cached per million.
  assert.ok(Math.abs(costOfResponse('gpt-5.5-2026-04-23', u).cost - (3 + 3 + 0.2)) < 1e-9);
  assert.ok(priceFor('gpt-5.4-mini'));
});

test('OpenAI usage with nothing reported counts as zero', () => {
  assert.deepEqual(usageOf(), { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
});

test('OpenAI is configured by OPENAI_API_KEY', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(openaiConfigured(), false);
  process.env.OPENAI_API_KEY = 'k';
  assert.equal(openaiConfigured(), true);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

/** A fake OpenAI client: `create` answers each request, which is recorded. */
function fakeOpenAI(create) {
  const requests = [];
  _setClientForTest({ responses: { create: async (req, opts) => { requests.push({ ...req, _opts: opts }); return create(req); } } });
  return requests;
}
const events = (...list) => (async function* () { yield* list; })();
const done = (status = 'completed') => ({ type: `response.${status}`, response: { status, model: 'gpt-5.5', usage: { input_tokens: 4, output_tokens: 2 } } });

test('OpenAI structured call: strict schema, and the JSON only when the response completed', async (t) => {
  t.after(() => _setClientForTest(null));
  let res = { status: 'completed', output_text: '{"a":1}', model: 'gpt-5.4-mini', usage: { input_tokens: 4, output_tokens: 2 } };
  const requests = fakeOpenAI(() => res);
  const out = await openaiJson('SYS', 'question', { type: 'object' }, { name: 'search_query' });
  assert.deepEqual(out, { json: { a: 1 }, model: 'gpt-5.4-mini', usage: usageOf(res.usage) });
  const [req] = requests;
  assert.equal(req.model, 'gpt-5.4-mini', 'the quick model by default');
  assert.equal(req.instructions, 'SYS');
  assert.deepEqual(req.input, [{ role: 'user', content: 'question' }]);
  assert.deepEqual(req.text.format, { type: 'json_schema', name: 'search_query', schema: { type: 'object' }, strict: true });

  res = { ...res, status: 'incomplete' };
  assert.equal((await openaiJson('S', 'c', {})).json, null);
  res = { ...res, status: 'completed', output_text: 'not json' };
  assert.equal((await openaiJson('S', 'c', {})).json, null);
});

test('OpenAI streaming: text as it arrives; refusals and cut-off answers are reported like Claude\'s', async (t) => {
  t.after(() => _setClientForTest(null));
  let next = () => events({ type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' }, done());
  const requests = fakeOpenAI(() => next());
  const text = [];
  const signal = new AbortController().signal;
  const out = await openaiStream('SYS', [{ role: 'user', content: 'hi', extra: 'dropped' }], { onText: (x) => text.push(x) }, signal);
  assert.deepEqual(text, ['Hel', 'lo']);
  assert.deepEqual(out, { stopReason: 'end_turn', model: 'gpt-5.5', usage: usageOf({ input_tokens: 4, output_tokens: 2 }) });
  assert.deepEqual(requests[0].input, [{ role: 'user', content: 'hi' }]);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].reasoning.effort, 'low');
  assert.equal(requests[0]._opts.signal, signal);

  next = () => events({ type: 'response.refusal.delta', delta: 'no' }, done());
  assert.equal((await openaiStream('S', [], { onText() {} })).stopReason, 'refusal');
  next = () => events(done('incomplete'));
  assert.equal((await openaiStream('S', [], { onText() {} })).stopReason, 'max_tokens');
});

test('OpenAI streaming: a failed response or a stream with no end is an error', async (t) => {
  t.after(() => _setClientForTest(null));
  let next = () => events({ type: 'response.failed', response: { error: { message: 'quota exceeded' } } });
  fakeOpenAI(() => next());
  await assert.rejects(openaiStream('S', [], { onText() {} }), /OpenAI: quota exceeded/);
  next = () => events({ type: 'error', message: 'bad request' });
  await assert.rejects(openaiStream('S', [], { onText() {} }), /OpenAI: bad request/);
  next = () => events({ type: 'response.output_text.delta', delta: 'x' });
  await assert.rejects(openaiStream('S', [], { onText() {} }), /stream ended without a response/);
});
