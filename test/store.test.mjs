// Covers: The database: profiles, question history, peer suggestions, pushed content, admin insights, feedback and Claude spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, normalizeQuestion } from '../server/store.mjs';

const ago = (days, mins = 0) => new Date(Date.now() - days * 86_400_000 + mins * 60_000).toISOString();

function fixture() {
  const s = openStore(':memory:');
  s.saveUser('me', { name: 'Rosa', role: 'nurse' });
  s.saveUser('n1', { role: 'nurse' });
  s.saveUser('n2', { role: 'nurse' });
  s.saveUser('doc', { role: 'physician' });
  return s;
}

test('profiles: create, then update only the given fields', () => {
  const s = fixture();
  assert.equal(s.getUser('me').role, 'nurse');
  s.saveUser('me', { department: 'ICU' });
  assert.deepEqual([s.getUser('me').name, s.getUser('me').role, s.getUser('me').department], ['Rosa', 'nurse', 'ICU']);
  assert.equal(s.getUser('nobody'), null);
});

test('history groups turns into conversations, newest first', () => {
  const s = fixture();
  s.addTurn({ userId: 'me', conversationId: 'a', at: ago(3), question: 'Old question', topics: ['Abridge'] });
  s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1), question: 'New question', topics: [] });
  s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1, 1), question: 'Follow-up', topics: [] });
  const c = s.conversations('me');
  assert.deepEqual(c.map((x) => [x.conversationId, x.title, x.turns]), [['b', 'New question', 2], ['a', 'Old question', 1]]);
  assert.equal(s.conversation('me', 'b').length, 2);
  assert.equal(s.conversation('doc', 'b').length, 0, "can't read someone else's conversation");
});

test('topics a user asked about, most frequent first', () => {
  const s = fixture();
  s.addTurn({ userId: 'me', conversationId: 'a', at: ago(5), question: 'q', topics: ['Abridge'] });
  s.addTurn({ userId: 'me', conversationId: 'a', at: ago(2), question: 'q', topics: ['Abridge', 'Training'] });
  assert.deepEqual(s.userTopics('me').map((t) => [t.topic, t.count]), [['Abridge', 2], ['Training', 1]]);
});

test('peer questions: same role, other people, topics I have not asked about', () => {
  const s = fixture();
  s.addTurn({ userId: 'me', conversationId: 'x', at: ago(1), question: 'Mine', topics: ['Abridge'] });
  s.addTurn({ userId: 'n1', conversationId: 'p', at: ago(2), question: 'When is the next upgrade?', topics: ['Epic upgrades'] });
  s.addTurn({ userId: 'n2', conversationId: 'q', at: ago(2), question: 'When is the next upgrade', topics: ['Epic upgrades'] });
  s.addTurn({ userId: 'n2', conversationId: 'q', at: ago(2), question: 'How do I use Abridge?', topics: ['Abridge'] });
  s.addTurn({ userId: 'doc', conversationId: 'r', at: ago(2), question: 'Physician question', topics: ['In Basket'] });
  s.addTurn({ userId: 'n1', conversationId: 'z', at: ago(2), question: 'Weak one', topics: ['Downtime'], lowConfidence: true });
  const p = s.peerQuestions('nurse', 'me');
  assert.equal(p.length, 1);
  assert.equal(p[0].people, 2);
  assert.equal(normalizeQuestion(p[0].question), 'when is the next upgrade');
});

test('promotions: audience, dates, and not re-shown after a click', () => {
  const s = fixture();
  const today = new Date().toISOString().slice(0, 10);
  const all = s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', roles: [] });
  s.savePromotion({ title: 'Surgeons only', prompt: 'p', roles: ['surgeon'] });
  s.savePromotion({ title: 'Expired', prompt: 'p', roles: [], ends: '2000-01-01' });
  s.savePromotion({ title: 'Off', prompt: 'p', roles: [], active: false });
  assert.deepEqual(s.promotionsFor('nurse', today).map((p) => p.title), ['Podcast']);
  s.addEvent({ userId: 'me', type: 'promo_click', ref: String(all.id) });
  assert.ok(s.promotionsActedOn('me').has(all.id));
});

test('insights flag weak matches, thumbs down, and questions asked again', () => {
  const s = fixture();
  const a = s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1), question: 'Haiku broken', topics: ['Haiku & Canto'] });
  s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1, 1), question: 'Haiku not working on phone', topics: ['Haiku & Canto'] });
  const b = s.addTurn({ userId: 'doc', conversationId: 'd', at: ago(1), question: 'Unknown thing', topics: [], lowConfidence: true });
  s.setFeedback(b, 'doc', -1, 'Not on the site?');
  const i = s.insights({ days: 7 });
  assert.equal(i.totals.questions, 3);
  const byId = new Map(i.trouble.map((t) => [t.id, t.reasons]));
  assert.deepEqual(byId.get(a), ['asked again']);
  assert.deepEqual(byId.get(b), ['weak match', 'thumbs down']);
  assert.equal(s.insights({ days: 7, role: 'physician' }).totals.questions, 1);
});

test('feedback only applies to your own turns', () => {
  const s = fixture();
  const t = s.addTurn({ userId: 'me', conversationId: 'c', question: 'q' });

test('feedback comments show up in insights, and clearing a rating drops it', () => {
  const s = fixture();
  const a = s.addTurn({ userId: 'me', conversationId: 'c', question: 'Where is the Haiku tip sheet?', answer: 'Here [1].' });
  const b = s.addTurn({ userId: 'doc', conversationId: 'd', question: 'q2' });
  s.setFeedback(a, 'me', -1, 'Linked the old version');
  s.setFeedback(b, 'doc', 1, null);
  let fb = s.insights().feedback;
  assert.deepEqual(fb.map((f) => [f.question, f.value, f.note]), [['q2', 1, null], ['Where is the Haiku tip sheet?', -1, 'Linked the old version']]);
  assert.equal(fb[1].answer, 'Here.');
  assert.equal(s.insights().totals.comments, 1);
  s.setFeedback(a, 'me', null, null);
  fb = s.insights().feedback;
  assert.deepEqual(fb.map((f) => f.question), ['q2']);
});
  assert.equal(s.setFeedback(t, 'doc', 1), false);
  assert.equal(s.setFeedback(t, 'me', 1), true);
  assert.equal(s.getTurn(t).feedback, 1);
});
test('pushed content keeps its link, and link opens are counted', () => {
  const s = fixture();
  const p = s.savePromotion({ title: 'Thrive', prompt: 'When is Thrive?', roles: [], url: 'https://example.org/thrive' });
  assert.equal(p.url, 'https://example.org/thrive');
  // Turning it off and on (the admin toggle re-saves the whole row) keeps the link.
  assert.equal(s.savePromotion({ ...p, active: false }).url, 'https://example.org/thrive');
  s.addEvent({ userId: 'me', type: 'promo_link_click', ref: String(p.id) });
  assert.equal(s.insights().promotions.find((x) => x.id === p.id).linkOpens, 1);
});

test('most asked questions carry their share of all questions', () => {
  const s = fixture();
  for (let i = 0; i < 3; i++) s.addTurn({ userId: 'n1', conversationId: `c${i}`, at: ago(1, i), question: 'Help desk number?', topics: [] });
  s.addTurn({ userId: 'n1', conversationId: 'c9', at: ago(1, 9), question: 'Haiku setup', topics: [] });
  const top = s.insights({ days: 7 }).topQuestions;
  assert.equal(top[0].count, 3);
  assert.equal(top[0].share, 0.75);
  assert.equal(top[1].share, 0.25);
});

test('Claude spend: priced per call, cache reads cheap, fallback attempts at their own rates', () => {
  const s = fixture();
  s.addTurn({ userId: 'me', conversationId: 'c1', at: ago(1), question: 'q', mode: 'claude' });
  // Opus 5: $5 in, $25 out, $0.50 cache read per million.
  s.addLlmCall({ userId: 'me', at: ago(1), purpose: 'answer', model: 'claude-opus-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 } });
  s.addLlmCall({ userId: 'doc', at: ago(1), purpose: 'rewrite', model: 'claude-opus-5-20260101', usage: { input_tokens: 200_000, output_tokens: 0 } });
  // A Fable decline rescued by Opus 4.8: every attempt in usage.iterations is billed.
  s.addLlmCall({ at: ago(1), purpose: 'answer', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1, iterations: [
    { type: 'message', model: 'claude-fable-5-1', input_tokens: 100_000, output_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 100_000, output_tokens: 0 },
  ] } });
  s.addLlmCall({ at: ago(1), purpose: 'welcome', model: 'not-a-model', usage: { input_tokens: 5 } });
  s.addLlmCall({ at: ago(40), purpose: 'answer', model: 'claude-opus-5', usage: { input_tokens: 1_000_000 } });

  const sp = s.insights({ days: 7 }).spend;
  assert.equal(sp.calls, 4);
  assert.equal(sp.unpriced, 1);
  assert.equal(sp.answered, 1);
  assert.ok(Math.abs(sp.cost - (5 + 2.5 + 0.5 + 1 + 1 + 0.5)) < 1e-9);
  assert.equal(sp.byPurpose[0].key, 'answer');
  assert.equal(sp.tokens.cacheRead, 1_000_000);
  // The role filter applies to spend too.
  assert.ok(Math.abs(s.insights({ days: 7, role: 'physician' }).spend.cost - 1) < 1e-9);
  s.addLlmCall({ at: ago(1), purpose: 'answer', model: 'claude-opus-5', usage: {}, demo: true });
  s.clearDemo();
  assert.equal(s.insights({ days: 7 }).spend.calls, 4);
});

test('removing questions from history hides them from the person, not from admin counts', () => {
  const s = fixture();
  s.addTurn({ userId: 'me', conversationId: 'a', at: ago(2), question: 'Keep me', topics: ['Abridge'] });
  s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1), question: 'Remove me', topics: ['Training'] });
  s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1), question: 'Not mine', topics: [] });
  assert.equal(s.hideHistory('doc', 'b'), 0, "can't remove someone else's conversation");
  assert.equal(s.hideHistory('me', 'b'), 1);
  assert.deepEqual(s.conversations('me').map((c) => c.conversationId), ['a']);
  assert.equal(s.conversation('me', 'b').length, 0);
  assert.deepEqual(s.recentTurns('me').map((t) => t.question), ['Keep me']);
  assert.deepEqual(s.userTopics('me').map((t) => t.topic), ['Abridge']);
  assert.equal(s.peerQuestions('nurse', 'n2').some((p) => p.question === 'Remove me'), false, 'not suggested to others');
  assert.equal(s.hideHistory('me'), 1);
  assert.equal(s.conversations('me').length, 0);
  assert.equal(s.conversations('n1').length, 1, "clearing mine leaves others' history");
  assert.equal(s.insights({ days: 30 }).totals.questions, 3, 'still counted for admins');
});
