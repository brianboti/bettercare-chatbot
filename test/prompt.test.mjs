// Covers: What the model is told: the system rules, the search-rewrite output format, and the question sent with its numbered excerpts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM, REWRITE_SYSTEM, PROMPT_VERSION, rewriteSchema, buildUserTurn } from '../server/prompt.mjs';
import { TOPIC_NAMES } from '../server/topics.mjs';

test('the prompt version is a dated id', () => {
  assert.match(PROMPT_VERSION, /^bc-\d{4}-\d{2}-\d{2}\.\d+$/);
});

test('the system prompt keeps the rules every answer depends on', () => {
  assert.match(SYSTEM, /Sophia/);
  assert.match(SYSTEM, /That information doesn't exist in the BetterCare documents/);
  assert.match(SYSTEM, /<assumptions>/);
  assert.match(SYSTEM, /<suggestions/);
  assert.match(SYSTEM, /\[\d\]|\[n\]/, 'asks for numbered citations');
});

test('the rewrite prompt asks for the fields the schema requires', () => {
  for (const f of ['query', 'topics', 'intent', 'context']) assert.match(REWRITE_SYSTEM, new RegExp(f));
});

test('rewriteSchema: strict object, topics limited to the given list', () => {
  const s = rewriteSchema(TOPIC_NAMES);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['query', 'topics', 'intent', 'context']);
  assert.deepEqual(s.properties.topics.items.enum, TOPIC_NAMES);
  assert.deepEqual(s.properties.intent.enum, ['direct', 'howto', 'troubleshoot', 'broad', 'followup', 'offtopic']);
  assert.notEqual(rewriteSchema(['A']).properties.topics.items.enum, s.properties.topics.items.enum);
});

const chunk = (over = {}) => ({ id: 'c1', title: 'Haiku Setup', kind: 'document', url: 'https://x/h.pdf', text: 'Install Haiku from the App Store.', meta: {}, ...over });
const base = { lowConfidence: false, today: '2026-06-01', facts: 'Next upgrade: vAug2026' };

test('excerpts are numbered in order with kind, heading path, location, date and URL', () => {
  const t = buildUserTurn('How do I set up Haiku?', [
    chunk({ headingPath: ['iPhone'], list: 'Tip Sheets', sourceType: 'file', meta: { date: '2026-05-01', shownOn: 'Mobile' } }),
    chunk({ id: 'c2', title: 'Second', kind: 'page', sourceType: 'page', list: 'Site Pages', meta: { modified: '2026-01-01' } }),
  ], base);
  assert.match(t, /\[1\] Document: Haiku Setup > iPhone\nLocation: Tip Sheets, shown on page "Mobile"\nDate: 2026-05-01\nURL: https:\/\/x\/h\.pdf\nInstall Haiku/);
  assert.match(t, /\[2\] Site page: Second\nDate: 2026-01-01\nURL:/, 'pages do not repeat their list as a location');
  assert.ok(t.indexOf('[1]') < t.indexOf('[2]'));
  assert.match(t, /\n\n---\n\n/);
});

test('excerpts carry their links (at most eight) and older sources are marked', () => {
  const links = Array.from({ length: 10 }, (_, i) => ({ text: `L${i}`, url: `https://l/${i}` }));
  const t = buildUserTurn('q', [chunk({ links, meta: { date: '2020-01-01' } })], { ...base, older: new Set(['c1']) });
  assert.match(t, /Links:\n {2}- L0: https:\/\/l\/0/);
  assert.match(t, /L7/);
  assert.doesNotMatch(t, /L8/);
  assert.match(t, /Date: 2020-01-01 \(older: well before the newest matches\)/);
});

test('an unknown kind is shown as-is', () => {
  assert.match(buildUserTurn('q', [chunk({ kind: 'mystery' })], base), /\[1\] mystery: Haiku Setup/);
});

test('no results, no facts and no person still give a well-formed turn', () => {
  const t = buildUserTurn('Anything?', [], { lowConfidence: false, today: '2026-06-01' });
  assert.match(t, /<excerpts>\n\(no matching content found\)\n<\/excerpts>/);
  assert.match(t, /<site_facts>\n\n<\/site_facts>/);
  assert.match(t, /<person>\n\(unknown\)\n<\/person>/);
  assert.match(t, /Today's date: 2026-06-01/);
  assert.match(t, /Question: Anything\?$/);
});

test('weak matches and broad questions add their instructions; plain questions do not', () => {
  const plain = buildUserTurn('q', [chunk()], base);
  assert.doesNotMatch(plain, /weak matches|broad question/);
  assert.match(buildUserTurn('q', [chunk()], { ...base, lowConfidence: true }), /only weak matches/);
  assert.match(buildUserTurn('q', [chunk()], { ...base, broad: true }), /This is a broad question/);
});

test('each intent gets its hint; other intents get none', () => {
  assert.match(buildUserTurn('q', [], { ...base, intent: 'direct' }), /direct question/);
  assert.match(buildUserTurn('q', [], { ...base, intent: 'howto' }), /how-to question/);
  assert.match(buildUserTurn('q', [], { ...base, intent: 'troubleshoot' }), /troubleshooting question/);
  assert.doesNotMatch(buildUserTurn('q', [], { ...base, intent: 'offtopic' }), /looks like/);
});

test('what the person said in the conversation goes with their profile', () => {
  const t = buildUserTurn('q', [], { ...base, person: 'Role: Nurse', said: ["I'm a surgeon", 'I use ProcDoc'] });
  assert.match(t, /<person>\nRole: Nurse\nIn this conversation they've said: I'm a surgeon; I use ProcDoc\n<\/person>/);
});
