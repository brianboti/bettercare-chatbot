import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionSplitter, parseSuggestions } from '../server/followups.mjs';

/** Feed text in arbitrary pieces, as a stream would. */
function run(pieces) {
  const s = new SuggestionSplitter();
  let shown = pieces.map((p) => s.push(p)).join('');
  const end = s.finish();
  shown += end.text;
  return { shown, suggestions: end.suggestions };
}

test('cuts the suggestions block out of the visible answer', () => {
  const r = run(['Call (210) 450-4800 [1].\n\n<sugg', 'estions kind="followup">\nHow do I', ' submit a ticket?\n- Where is my ticket?\n</suggestions>']);
  assert.equal(r.shown.trim(), 'Call (210) 450-4800 [1].');
  assert.deepEqual(r.suggestions, { kind: 'followup', items: ['How do I submit a ticket?', 'Where is my ticket?'] });
});

test('never shows a partial tag, even one character at a time', () => {
  const text = 'Answer.\n<suggestions kind="reply">\nYes\nNo\n</suggestions>';
  const r = run([...text]);
  assert.equal(r.shown, 'Answer.\n');
  assert.equal(r.suggestions.kind, 'reply');
});

test('text that only looks like the start of a tag is released at the end', () => {
  const r = run(['Use the <sug', 'ar> field']);
  assert.equal(r.shown, 'Use the <sugar> field');
  assert.equal(r.suggestions, null);
});

test('an unterminated block still parses; long or empty lines are dropped', () => {
  const s = parseSuggestions(`<suggestions>\n\n${'x'.repeat(200)}\n1. First\n2) Second`);
  assert.deepEqual(s, { kind: 'followup', items: ['First', 'Second'] });
});
