// Covers: Pricing Claude and OpenAI calls from their usage: model ids with dates or platform prefixes, cache reads and writes, and fallback attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, tokensOf, costOfResponse } from '../server/pricing.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('priceFor knows the models and tolerates date suffixes and platform prefixes', () => {
  assert.deepEqual(priceFor('claude-opus-5'), [5, 25, 6.25, 10, 0.5]);
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), priceFor('claude-haiku-4-5'));
  assert.deepEqual(priceFor('claude-sonnet-4-6@20260101'), priceFor('claude-sonnet-4-6'));
  assert.deepEqual(priceFor('us.anthropic.claude-opus-4-7'), priceFor('claude-opus-4-7'));
  assert.deepEqual(priceFor('anthropic.claude-opus-4-7'), priceFor('claude-opus-4-7'));
  assert.deepEqual(priceFor('gpt-5.4-mini-2026-03-05'), priceFor('gpt-5.4-mini'));
});

test('priceFor returns null for unknown or missing models', () => {
  assert.equal(priceFor('some-other-model'), null);
  assert.equal(priceFor(undefined), null);
  assert.equal(priceFor(''), null);
});

test('tokensOf reads every token field and treats missing ones as zero', () => {
  assert.deepEqual(tokensOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 1 } }),
    { input: 10, output: 5, cacheRead: 3, cacheWrite: 4, write1h: 1 });
  assert.deepEqual(tokensOf(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, write1h: 0 });
  assert.deepEqual(tokensOf({}), tokensOf());
});

test('costOfResponse: input, output, cache reads and 5-minute vs 1-hour cache writes at their own rates', () => {
  // opus-5: 5 in, 25 out, 6.25 5m write, 10 1h write, 0.5 read (per million)
  const { cost, tokens } = costOfResponse('claude-opus-5', {
    input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 3_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
  });
  close(cost, 5 + 25 + 0.5 + 2 * 6.25 + 10);
  assert.deepEqual(tokens, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 3_000_000 });
});

test('costOfResponse with no usage costs nothing', () => {
  assert.deepEqual(costOfResponse('claude-opus-5'), { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
});

test('costOfResponse is null for an unpriced model but still counts tokens', () => {
  const r = costOfResponse('mystery-model', { input_tokens: 7, output_tokens: 3 });
  assert.equal(r.cost, null);
  assert.equal(r.tokens.input, 7);
});

test('costOfResponse bills each fallback attempt at the rates of the model that ran it', () => {
  const { cost, tokens } = costOfResponse('claude-opus-5', { iterations: [
    { model: 'claude-fable-5-1', input_tokens: 1_000_000, output_tokens: 0 },
    { input_tokens: 1_000_000, output_tokens: 0 },   // no model: the response's model
  ] });
  close(cost, 10 + 5);
  assert.equal(tokens.input, 2_000_000);
});

test('costOfResponse is null when any attempt ran on an unpriced model', () => {
  const r = costOfResponse('claude-opus-5', { iterations: [{ model: 'mystery', input_tokens: 1 }, { input_tokens: 1 }] });
  assert.equal(r.cost, null);
  assert.equal(r.tokens.input, 2);
});

test('an empty iterations list falls back to the top-level usage', () => {
  close(costOfResponse('claude-haiku-4-5', { iterations: [], output_tokens: 1_000_000 }).cost, 5);
});
