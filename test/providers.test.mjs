// Covers: the backup provider: which Claude errors switch to OpenAI, and OpenAI usage priced like Claude's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { failoverReason } from '../server/llm.mjs';
import { usageOf } from '../server/openai.mjs';
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
