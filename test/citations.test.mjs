// Covers: Finding bullets and steps without a citation, adding the right one after the answer is written, and the help-desk line every answer ends with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncitedItems, repairCitations } from '../server/citations.mjs';
import { helpLine, hasHelp, withHelpSource, HELP_SOURCE_ID } from '../server/help.mjs';

const ex = (title, text) => ({ title, text });

test('uncitedItems finds dash, star, bullet-dot and numbered items without a [n]', () => {
  const answer = ['Intro [1].', '- dash item', '* star item', '• dot item', '1. numbered step', '2) paren step', '- cited item [2]', '- two cited [1, 3]'].join('\n');
  assert.deepEqual(uncitedItems(answer), ['dash item', 'star item', 'dot item', 'numbered step', 'paren step']);
});

test('uncitedItems ignores plain sentences, empty bullets and questions back to the person', () => {
  assert.deepEqual(uncitedItems('Just a sentence.\n- \n- Which version are you on?\n  - nested bare'), ['nested bare']);
  assert.deepEqual(uncitedItems(''), []);
  assert.deepEqual(uncitedItems(undefined), []);
});

test('repairCitations leaves a fully cited answer unchanged', () => {
  const answer = 'Lead [1]:\n- one [1]\n- two [2]';
  assert.deepEqual(repairCitations(answer, [ex('A', 'one'), ex('B', 'two')]), { text: answer, added: 0, unresolved: [] });
});

test('repairCitations puts the number before trailing punctuation and keeps the bullet marker', () => {
  const r = repairCitations('  1. Open the Abridge app on your iPhone.', [ex('Abridge', 'Open the Abridge app on your iPhone to start')]);
  assert.equal(r.text, '  1. Open the Abridge app on your iPhone [1].');
  assert.equal(r.added, 1);
});

test('repairCitations picks the excerpt with the most word overlap', () => {
  const r = repairCitations('- Register for Thrive training classes online', [
    ex('Haiku', 'Haiku mobile app setup'), ex('Thrive', 'Register online for Thrive training classes'),
  ]);
  assert.equal(r.text, '- Register for Thrive training classes online [2]');
});

test('repairCitations falls back to what the lead-in sentence cited when overlap is low', () => {
  const r = repairCitations('The objectives cover this [2]:\n- documentation speed improvements', [
    ex('Other', 'unrelated words entirely'), ex('Objectives', 'Faster documentation with fewer clicks and speed'),
  ]);
  assert.equal(r.text.split('\n')[1], '- documentation speed improvements [2]');
});

test('repairCitations ignores lead-in citations that point past the excerpts', () => {
  const r = repairCitations('Lead [9]:\n- zebra quantum', [ex('A', 'apples')]);
  assert.equal(r.added, 0);
  assert.deepEqual(r.unresolved, ['zebra quantum']);
});

test('repairCitations reports what it could not support instead of citing at random', () => {
  const r = repairCitations('- completely unrelated statement here', [ex('A', 'Abridge recording tips')]);
  assert.equal(r.text, '- completely unrelated statement here');
  assert.deepEqual(r.unresolved, ['completely unrelated statement here']);
});

test('repairCitations with no excerpts adds nothing', () => {
  assert.deepEqual(repairCitations('- a bare bullet', []), { text: '- a bare bullet', added: 0, unresolved: ['a bare bullet'] });
});

test('repairCitations counts plurals as the same word', () => {
  const r = repairCitations('- Print the tip sheets', [ex('Tip sheet', 'print a tip sheet')]);
  assert.equal(r.text, '- Print the tip sheets [1]');
});

test('helpLine cites the given number and names the help desk contacts', () => {
  const l = helpLine(7);
  assert.match(l, /210-450-4800/);
  assert.match(l, /210-450-HELP/);
  assert.match(l, /HealthITSupport@uthscsa\.edu/);
  assert.match(l, /\[7\]\.$/);
});

test('hasHelp recognises the help desk number however it is written', () => {
  for (const s of ['call 210-450-4800', 'call 450 4800', 'call 450.4800', 'call 450-HELP', 'call 450-help']) assert.equal(hasHelp(s), true, s);
  for (const s of ['call 210-567-4800', 'no number here', '']) assert.equal(hasHelp(s), false, s);
});

test('withHelpSource adds the footer once, does nothing without it, and leaves the input alone', () => {
  const footer = { id: HELP_SOURCE_ID, text: 'Help desk' };
  const retriever = { get: (id) => (id === HELP_SOURCE_ID ? footer : undefined) };
  const results = [{ id: 'a' }];
  assert.deepEqual(withHelpSource(results, retriever), [{ id: 'a' }, footer]);
  assert.deepEqual(results, [{ id: 'a' }], 'not changed in place');
  const already = [footer, { id: 'a' }];
  assert.equal(withHelpSource(already, retriever), already);
  assert.deepEqual(withHelpSource(results, { get: () => undefined }), results);
  assert.deepEqual(withHelpSource(results, {}), results, 'a retriever without get() is tolerated');
});
