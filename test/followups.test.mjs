// Covers: The follow-up question chips: cutting the suggestions block out of a streamed answer, and reading the chips from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionSplitter, parseSuggestions, AssumptionSplitter, parseAssumptions } from '../server/followups.mjs';

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
test('parseSuggestions reads the kind, strips list markers and quotes, and keeps four at most', () => {
  const r = parseSuggestions('<suggestions kind="reply">\n- "Yes"\n2. No\n• Maybe\n* Later\nFifth\n</suggestions>');
  assert.deepEqual(r, { kind: 'reply', items: ['Yes', 'No', 'Maybe', 'Later'] });
});

test('parseSuggestions defaults to follow-ups and returns null for nothing usable', () => {
  assert.equal(parseSuggestions('<suggestions>\nWhat next?\n</suggestions>').kind, 'followup');
  assert.equal(parseSuggestions('<suggestions>\n\n</suggestions>'), null);
  assert.equal(parseSuggestions(''), null);
  assert.equal(parseSuggestions(null), null);
  assert.equal(parseSuggestions('no block'), null);
});

test('an answer without suggestions streams through whole', () => {
  assert.deepEqual(run(['Plain ', 'answer.']), { shown: 'Plain answer.', suggestions: null });
});

/** Feed the assumption splitter in pieces; collect what is shown and what was assumed. */
function assume(pieces) {
  let got = null;
  const s = new AssumptionSplitter((a) => { got = a; });
  const shown = pieces.map((p) => s.push(p)).join('') + s.finish();
  return { shown, assumptions: got };
}

test('AssumptionSplitter: leading whitespace before the block is fine, text after it is shown', () => {
  const r = assume(['\n  <assump', 'tions>\nYou use Epic | I don\'t\n</assumptions>\n\nAnswer [1].']);
  assert.equal(r.shown, 'Answer [1].');
  assert.deepEqual(r.assumptions, [{ text: 'You use Epic', fix: "I don't" }]);
});

test('AssumptionSplitter: text that only starts like the tag is released', () => {
  assert.deepEqual(assume(['<a', 'b>bold claim']), { shown: '<ab>bold claim', assumptions: null });
  assert.deepEqual(assume(['<as']), { shown: '<as', assumptions: null });
});

test('AssumptionSplitter: a block that never closes is dropped but still read', () => {
  const r = assume(['<assumptions>\nYou are a nurse | I am not']);
  assert.equal(r.shown, '');
  assert.deepEqual(r.assumptions, [{ text: 'You are a nurse', fix: 'I am not' }]);
});

test('AssumptionSplitter: a block later in the answer is not treated as assumptions', () => {
  const r = assume(['Answer first. <assumptions>x</assumptions>']);
  assert.equal(r.shown, 'Answer first. <assumptions>x</assumptions>');
  assert.equal(r.assumptions, null);
});

test('AssumptionSplitter works without a callback', () => {
  const s = new AssumptionSplitter();
  assert.equal(s.push('<assumptions>\nA\n</assumptions>Hi'), 'Hi');
});

test('parseAssumptions: three at most, list markers and quotes stripped, long text capped', () => {
  const block = `<assumptions>\n- "One" | "Not one"\n2. Two\n${'x'.repeat(200)} | ${'y'.repeat(100)}\nFour\n</assumptions>`;
  const a = parseAssumptions(block);
  assert.equal(a.length, 3);
  assert.deepEqual(a[0], { text: 'One', fix: 'Not one' });
  assert.deepEqual(a[1], { text: 'Two', fix: null });
  assert.equal(a[2].text.length, 120);
  assert.equal(a[2].fix.length, 80);
});

test('parseAssumptions: nothing usable gives an empty list', () => {
  assert.deepEqual(parseAssumptions(''), []);
  assert.deepEqual(parseAssumptions(undefined), []);
  assert.deepEqual(parseAssumptions('<assumptions>\n | only a fix\n</assumptions>'), []);
});
