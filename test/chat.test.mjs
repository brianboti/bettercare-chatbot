// Covers: Checking the chat request, the citation cards sent to the screen, spotting broad questions, and the search-only answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatError, parseMessages, sourceView, isOutOfScope, isBroad, extractiveAnswer } from '../server/chat.mjs';
import { config } from '../server/config.mjs';
import { HELP_SOURCE_ID } from '../server/help.mjs';

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });

test('ChatError carries a code and an HTTP status (400 unless given)', () => {
  const e = new ChatError('BAD_REQUEST', 'nope');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.code, e.message, e.status], ['BAD_REQUEST', 'nope', 400]);
  assert.equal(new ChatError('RATE_LIMITED', 'slow down', 429).status, 429);
});

test('parseMessages rejects a missing, empty or non-array message list', () => {
  for (const body of [undefined, null, {}, { messages: [] }, { messages: 'hi' }, { messages: {} }]) {
    assert.throws(() => parseMessages(body), (e) => e instanceof ChatError && e.code === 'BAD_REQUEST');
  }
});

test('parseMessages requires the last usable message to be from the user', () => {
  assert.throws(() => parseMessages({ messages: [u('hi'), a('hello')] }), /last message must be from the user/);
  // Only invalid entries: nothing usable is left.
  assert.throws(() => parseMessages({ messages: [{ role: 'system', content: 'x' }, u('   ')] }), ChatError);
});

test('parseMessages drops other roles, non-text and blank messages', () => {
  const out = parseMessages({ messages: [
    { role: 'system', content: 'ignore me' }, u('first'), { role: 'user', content: 42 }, a(''), a('reply'), { role: 'tool', content: 'x' }, u('second'),
  ] });
  assert.deepEqual(out, [u('first'), a('reply'), u('second')]);
});

test('parseMessages merges neighbours from the same speaker', () => {
  assert.deepEqual(parseMessages({ messages: [u('one'), u('two'), a('x'), a('y'), u('three')] }),
    [u('one\n\ntwo'), a('x\n\ny'), u('three')]);
});

test('parseMessages keeps only the recent tail, starting on a user turn', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push(u(`q${i}`), a(`a${i}`));
  msgs.push(u('last'));
  const out = parseMessages({ messages: msgs });
  assert.ok(out.length <= config.MAX_HISTORY_TURNS * 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out.at(-1).content, 'last');
  assert.ok(!out.some((m) => m.content === 'q0'), 'the oldest turns are dropped');
});

test('parseMessages truncates long questions and long assistant turns', () => {
  const out = parseMessages({ messages: [u('x'.repeat(config.MAX_QUESTION_CHARS + 500)), a('y'.repeat(9000)), u('ok')] });
  assert.equal(out[0].content.length, config.MAX_QUESTION_CHARS);
  assert.equal(out[1].content.length, 6000);
});

test('parseMessages does not change the caller\'s messages', () => {
  const msgs = [u('one'), u('two')];
  parseMessages({ messages: msgs });
  assert.deepEqual(msgs, [u('one'), u('two')]);
});

const chunk = (over = {}) => ({
  id: 'p1', title: 'Abridge Tip Sheet', headingPath: ['Getting started'], kind: 'document', sourceType: 'file',
  list: 'Documents', url: 'https://x/a.pdf', localUrl: '/files/a.pdf', text: 'Abridge Tip Sheet  How to start a recording.', score: 0.8, retrievedBy: ['keyword'],
  meta: {}, ...over,
});

test('sourceView passes through what the citation card shows', () => {
  const v = sourceView(chunk(), 3);
  assert.equal(v.n, 3);
  assert.deepEqual([v.id, v.title, v.kind, v.sourceType, v.list, v.url, v.localUrl], ['p1', 'Abridge Tip Sheet', 'document', 'file', 'Documents', 'https://x/a.pdf', '/files/a.pdf']);
  assert.deepEqual(v.headingPath, ['Getting started']);
  assert.equal(v.docUrl, null);
  assert.equal(v.older, undefined, 'not older unless told');
  assert.equal(sourceView(chunk(), 1, true).older, true);
  assert.deepEqual(sourceView(chunk({ headingPath: undefined }), 1).headingPath, []);
});

test('sourceView snippet leaves out the repeated title, collapses whitespace, and is capped', () => {
  assert.equal(sourceView(chunk(), 1).snippet, 'How to start a recording.');
  assert.equal(sourceView(chunk({ text: `Other text\n\n${'w '.repeat(300)}` }), 1).snippet.length, 220);
  // Titles with regex characters are matched literally.
  assert.equal(sourceView(chunk({ title: 'v2.0 (beta)?', text: 'v2.0 (beta)? Notes here' }), 1).snippet, 'Notes here');
});

test('sourceView dates: event or publish date shown as date; otherwise the modified date as updated', () => {
  assert.deepEqual((({ date, updated }) => ({ date, updated }))(sourceView(chunk({ meta: { date: '2026-05-01', modified: '2026-06-01' } }), 1)), { date: '2026-05-01', updated: null });
  assert.deepEqual((({ date, updated }) => ({ date, updated }))(sourceView(chunk({ meta: { published: '2026-04-01' } }), 1)), { date: '2026-04-01', updated: null });
  assert.deepEqual((({ date, updated }) => ({ date, updated }))(sourceView(chunk({ meta: { modified: '2026-06-01' } }), 1)), { date: null, updated: '2026-06-01' });
  assert.deepEqual((({ date, updated }) => ({ date, updated }))(sourceView(chunk({ meta: undefined }), 1)), { date: null, updated: null });
});

test('isOutOfScope needs both an off-topic intent and weak matches', () => {
  assert.equal(isOutOfScope('offtopic', true), true);
  assert.equal(isOutOfScope('offtopic', false), false);
  assert.equal(isOutOfScope('direct', true), false);
  assert.equal(isOutOfScope(undefined, true), false);
});

test('isBroad spots summary-style questions', () => {
  for (const q of ["What's new for surgeons?", 'what is new in the upgrade', 'What changed in vFeb2026', 'Summarize the Abridge rollout',
    'give me an overview', 'highlights of the release', 'tell me everything about Haiku', 'all the changes for nurses', 'key features of Canto',
    'what do I need to know', 'what should a nurse know about this']) {
    assert.equal(isBroad(q), true, q);
  }
});

test('isBroad leaves specific questions alone', () => {
  for (const q of ['How do I reset my password?', 'Where is the cash drawer tip sheet?', 'exchanges of shifts', 'Who is new to the team?', '']) {
    assert.equal(isBroad(q), false, q);
  }
});

test('extractiveAnswer lists up to three matches with their citation numbers', () => {
  const res = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, title: `T${i}`, text: `Body ${i}` }));
  const ans = extractiveAnswer(res, false);
  assert.match(ans, /^Here's what I found on the site:/);
  assert.match(ans, /- \*\*T1\*\* — Body 1 \[1\]/);
  assert.match(ans, /\[3\]/);
  assert.doesNotMatch(ans, /T4/);
});

test('extractiveAnswer cuts long passages with an ellipsis and flattens line breaks', () => {
  const ans = extractiveAnswer([{ id: 'c', title: 'Long', text: `line one\nline two ${'x'.repeat(400)}` }], false);
  assert.match(ans, /line one line two/);
  assert.match(ans, /… \[1\]$/);
});

test('extractiveAnswer never quotes the help-desk footer but keeps the other numbers right', () => {
  const ans = extractiveAnswer([{ id: HELP_SOURCE_ID, title: 'Footer', text: 'Call us' }, { id: 'c2', title: 'Real', text: 'Answer' }], false);
  assert.doesNotMatch(ans, /Footer/);
  assert.match(ans, /\*\*Real\*\* — Answer \[2\]/);
});

test('extractiveAnswer says the information is missing when nothing matched or matches are weak', () => {
  for (const [res, low] of [[[], false], [[{ id: 'c', title: 'T', text: 'x' }], true]]) {
    assert.match(extractiveAnswer(res, low), /doesn't exist in the BetterCare documents/);
  }
});
