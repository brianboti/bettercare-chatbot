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
  assert.equal(s.setFeedback(t, 'doc', 1), false);
  assert.equal(s.setFeedback(t, 'me', 1), true);
  assert.equal(s.getTurn(t).feedback, 1);
});
