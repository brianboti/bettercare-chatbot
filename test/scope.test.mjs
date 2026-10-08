// Covers: Staying on topic: questions unrelated to BetterCare get the fixed "doesn't exist in the BetterCare documents" reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOutOfScope, OUT_OF_SCOPE_ANSWER, extractiveAnswer } from '../server/chat.mjs';

test('skips the model only when the question is off-topic and nothing matches', () => {
  assert.equal(isOutOfScope('offtopic', true), true);
  assert.equal(isOutOfScope('offtopic', false), false); // something on the site matched: let the model look
  assert.equal(isOutOfScope('direct', true), false);    // on-topic but weak: the model says what's missing
  assert.equal(isOutOfScope(null, true), false);        // rewrite failed: no intent, don't guess
});

test('the fixed reply says the information is not in the documents and cites nothing', () => {
  assert.match(OUT_OF_SCOPE_ANSWER, /doesn't exist in the BetterCare documents/);
  assert.doesNotMatch(OUT_OF_SCOPE_ANSWER, /\[\d+\]/);
});

test('search-only mode uses the same wording when nothing matches', () => {
  assert.match(extractiveAnswer([], true), /doesn't exist in the BetterCare documents/);
});