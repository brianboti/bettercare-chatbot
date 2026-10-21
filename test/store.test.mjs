// Covers: The database (SQLite, and Firestore when its emulator runs): profiles, question history, peer suggestions, pushed content, admin insights, feedback and Claude spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestion } from '../server/store.mjs';
import { BACKENDS } from './store-backends.mjs';

const ago = (days, mins = 0) => new Date(Date.now() - days * 86_400_000 + mins * 60_000).toISOString();

async function fixture(backend) {
  const s = await backend.open();
  await s.saveUser('me', { name: 'Rosa', role: 'nurse' });
  await s.saveUser('n1', { role: 'nurse' });
  await s.saveUser('n2', { role: 'nurse' });
  await s.saveUser('doc', { role: 'physician' });
  return s;
}

for (const backend of BACKENDS) {

test(`${backend.name}: profiles: create, then update only the given fields`, async () => {
  const s = await fixture(backend);
  assert.equal((await s.getUser('me')).role, 'nurse');
  await s.saveUser('me', { department: 'ICU' });
  assert.deepEqual([(await s.getUser('me')).name, (await s.getUser('me')).role, (await s.getUser('me')).department], ['Rosa', 'nurse', 'ICU']);
  assert.equal(await s.getUser('nobody'), null);
});

test(`${backend.name}: history groups turns into conversations, newest first`, async () => {
  const s = await fixture(backend);
  await s.addTurn({ userId: 'me', conversationId: 'a', at: ago(3), question: 'Old question', topics: ['Abridge'] });
  await s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1), question: 'New question', topics: [] });
  await s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1, 1), question: 'Follow-up', topics: [] });
  const c = await s.conversations('me');
  assert.deepEqual(c.map((x) => [x.conversationId, x.title, x.turns]), [['b', 'New question', 2], ['a', 'Old question', 1]]);
  assert.equal((await s.conversation('me', 'b')).length, 2);
  assert.equal((await s.conversation('doc', 'b')).length, 0, "can't read someone else's conversation");
});

test(`${backend.name}: topics a user asked about, most frequent first`, async () => {
  const s = await fixture(backend);
  await s.addTurn({ userId: 'me', conversationId: 'a', at: ago(5), question: 'q', topics: ['Abridge'] });
  await s.addTurn({ userId: 'me', conversationId: 'a', at: ago(2), question: 'q', topics: ['Abridge', 'Training'] });
  assert.deepEqual((await s.userTopics('me')).map((t) => [t.topic, t.count]), [['Abridge', 2], ['Training', 1]]);
});

test(`${backend.name}: peer questions: same role, other people, topics I have not asked about`, async () => {
  const s = await fixture(backend);
  await s.addTurn({ userId: 'me', conversationId: 'x', at: ago(1), question: 'Mine', topics: ['Abridge'] });
  await s.addTurn({ userId: 'n1', conversationId: 'p', at: ago(2), question: 'When is the next upgrade?', topics: ['Epic upgrades'] });
  await s.addTurn({ userId: 'n2', conversationId: 'q', at: ago(2), question: 'When is the next upgrade', topics: ['Epic upgrades'] });
  await s.addTurn({ userId: 'n2', conversationId: 'q', at: ago(2), question: 'How do I use Abridge?', topics: ['Abridge'] });
  await s.addTurn({ userId: 'doc', conversationId: 'r', at: ago(2), question: 'Physician question', topics: ['In Basket'] });
  await s.addTurn({ userId: 'n1', conversationId: 'z', at: ago(2), question: 'Weak one', topics: ['Downtime'], lowConfidence: true });
  const p = await s.peerQuestions('nurse', 'me');
  assert.equal(p.length, 1);
  assert.equal(p[0].people, 2);
  assert.equal(normalizeQuestion(p[0].question), 'when is the next upgrade');
});

test(`${backend.name}: promotions: audience, dates, and not re-shown after a click`, async () => {
  const s = await fixture(backend);
  const today = new Date().toISOString().slice(0, 10);
  const all = await s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', roles: [] });
  await s.savePromotion({ title: 'Surgeons only', prompt: 'p', roles: ['surgeon'] });
  await s.savePromotion({ title: 'Expired', prompt: 'p', roles: [], ends: '2000-01-01' });
  await s.savePromotion({ title: 'Off', prompt: 'p', roles: [], active: false });
  assert.deepEqual((await s.promotionsFor('nurse', today)).map((p) => p.title), ['Podcast']);
  await s.addEvent({ userId: 'me', type: 'promo_click', ref: String(all.id) });
  assert.ok((await s.promotionsActedOn('me')).has(all.id));
});

test(`${backend.name}: insights flag weak matches, thumbs down, and questions asked again`, async () => {
  const s = await fixture(backend);
  const a = await s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1), question: 'Haiku broken', topics: ['Haiku & Canto'] });
  await s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1, 1), question: 'Haiku not working on phone', topics: ['Haiku & Canto'] });
  const b = await s.addTurn({ userId: 'doc', conversationId: 'd', at: ago(1), question: 'Unknown thing', topics: [], lowConfidence: true });
  await s.setFeedback(b, 'doc', -1, 'Not on the site?');
  const i = await s.insights({ days: 7 });
  assert.equal(i.totals.questions, 3);
  const byId = new Map(i.trouble.map((t) => [t.id, t.reasons]));
  assert.deepEqual(byId.get(a), ['asked again']);
  assert.deepEqual(byId.get(b), ['weak match', 'thumbs down']);
  assert.equal((await s.insights({ days: 7, role: 'physician' })).totals.questions, 1);
});

test(`${backend.name}: feedback only applies to your own turns`, async () => {
  const s = await fixture(backend);
  const t = await s.addTurn({ userId: 'me', conversationId: 'c', question: 'q' });

  assert.equal(await s.setFeedback(t, 'doc', 1), false);
  assert.equal(await s.setFeedback(t, 'me', 1), true);
  assert.equal((await s.getTurn(t)).feedback, 1);
});

test(`${backend.name}: feedback comments show up in insights, and clearing a rating drops it`, async () => {
  const s = await fixture(backend);
  const a = await s.addTurn({ userId: 'me', conversationId: 'c', question: 'Where is the Haiku tip sheet?', answer: 'Here [1].' });
  const b = await s.addTurn({ userId: 'doc', conversationId: 'd', question: 'q2' });
  await s.setFeedback(a, 'me', -1, 'Linked the old version');
  await s.setFeedback(b, 'doc', 1, null);
  let fb = (await s.insights()).feedback;
  assert.deepEqual(fb.map((f) => [f.question, f.value, f.note]), [['q2', 1, null], ['Where is the Haiku tip sheet?', -1, 'Linked the old version']]);
  assert.equal(fb[1].answer, 'Here.');
  assert.equal((await s.insights()).totals.comments, 1);
  await s.setFeedback(a, 'me', null, null);
  fb = (await s.insights()).feedback;
  assert.deepEqual(fb.map((f) => f.question), ['q2']);
});
test(`${backend.name}: pushed content keeps its link, and link opens are counted`, async () => {
  const s = await fixture(backend);
  const p = await s.savePromotion({ title: 'Thrive', prompt: 'When is Thrive?', roles: [], url: 'https://example.org/thrive' });
  assert.equal(p.url, 'https://example.org/thrive');
  // Turning it off and on (the admin toggle re-saves the whole row) keeps the link.
  assert.equal((await s.savePromotion({ ...p, active: false })).url, 'https://example.org/thrive');
  await s.addEvent({ userId: 'me', type: 'promo_link_click', ref: String(p.id) });
  assert.equal((await s.insights()).promotions.find((x) => x.id === p.id).linkOpens, 1);
});

test(`${backend.name}: most asked questions carry their share of all questions`, async () => {
  const s = await fixture(backend);
  for (let i = 0; i < 3; i++) await s.addTurn({ userId: 'n1', conversationId: `c${i}`, at: ago(1, i), question: 'Help desk number?', topics: [] });
  await s.addTurn({ userId: 'n1', conversationId: 'c9', at: ago(1, 9), question: 'Haiku setup', topics: [] });
  const top = (await s.insights({ days: 7 })).topQuestions;
  assert.equal(top[0].count, 3);
  assert.equal(top[0].share, 0.75);
  assert.equal(top[1].share, 0.25);
});

test(`${backend.name}: Claude spend: priced per call, cache reads cheap, fallback attempts at their own rates`, async () => {
  const s = await fixture(backend);
  await s.addTurn({ userId: 'me', conversationId: 'c1', at: ago(1), question: 'q', mode: 'claude' });
  // Opus 5: $5 in, $25 out, $0.50 cache read per million.
  await s.addLlmCall({ userId: 'me', at: ago(1), purpose: 'answer', model: 'claude-opus-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 } });
  await s.addLlmCall({ userId: 'doc', at: ago(1), purpose: 'rewrite', model: 'claude-opus-5-20260101', usage: { input_tokens: 200_000, output_tokens: 0 } });
  // A Fable decline rescued by Opus 4.8: every attempt in usage.iterations is billed.
  await s.addLlmCall({ at: ago(1), purpose: 'answer', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1, iterations: [
    { type: 'message', model: 'claude-fable-5-1', input_tokens: 100_000, output_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 100_000, output_tokens: 0 },
  ] } });
  await s.addLlmCall({ at: ago(1), purpose: 'welcome', model: 'not-a-model', usage: { input_tokens: 5 } });
  await s.addLlmCall({ at: ago(40), purpose: 'answer', model: 'claude-opus-5', usage: { input_tokens: 1_000_000 } });

  const sp = (await s.insights({ days: 7 })).spend;
  assert.equal(sp.calls, 4);
  assert.equal(sp.unpriced, 1);
  assert.equal(sp.answered, 1);
  assert.ok(Math.abs(sp.cost - (5 + 2.5 + 0.5 + 1 + 1 + 0.5)) < 1e-9);
  assert.equal(sp.byPurpose[0].key, 'answer');
  assert.equal(sp.tokens.cacheRead, 1_000_000);
  // The role filter applies to spend too.
  assert.ok(Math.abs((await s.insights({ days: 7, role: 'physician' })).spend.cost - 1) < 1e-9);
  await s.addLlmCall({ at: ago(1), purpose: 'answer', model: 'claude-opus-5', usage: {}, demo: true });
  await s.clearDemo();
  assert.equal((await s.insights({ days: 7 })).spend.calls, 4);
});

test(`${backend.name}: removing questions from history hides them from the person, not from admin counts`, async () => {
  const s = await fixture(backend);
  await s.addTurn({ userId: 'me', conversationId: 'a', at: ago(2), question: 'Keep me', topics: ['Abridge'] });
  await s.addTurn({ userId: 'me', conversationId: 'b', at: ago(1), question: 'Remove me', topics: ['Training'] });
  await s.addTurn({ userId: 'n1', conversationId: 'c', at: ago(1), question: 'Not mine', topics: [] });
  assert.equal(await s.hideHistory('doc', 'b'), 0, "can't remove someone else's conversation");
  assert.equal(await s.hideHistory('me', 'b'), 1);
  assert.deepEqual((await s.conversations('me')).map((c) => c.conversationId), ['a']);
  assert.equal((await s.conversation('me', 'b')).length, 0);
  assert.deepEqual((await s.recentTurns('me')).map((t) => t.question), ['Keep me']);
  assert.deepEqual((await s.userTopics('me')).map((t) => t.topic), ['Abridge']);
  assert.equal((await s.peerQuestions('nurse', 'n2')).some((p) => p.question === 'Remove me'), false, 'not suggested to others');
  assert.equal(await s.hideHistory('me'), 1);
  assert.equal((await s.conversations('me')).length, 0);
  assert.equal((await s.conversations('n1')).length, 1, "clearing mine leaves others' history");
  assert.equal((await s.insights({ days: 30 })).totals.questions, 3, 'still counted for admins');
});

test(`${backend.name}: people: last-seen time, and listing everyone or only demo people by name`, async () => {
  const s = await fixture(backend);
  assert.equal((await s.getUser('me')).lastSeenAt, null);
  await s.touchUser('me');
  assert.ok((await s.getUser('me')).lastSeenAt);
  await s.saveUser('zed', { name: 'Zed', demo: true, isAdmin: true });
  assert.equal((await s.listUsers()).length, 5);
  assert.deepEqual((await s.listUsers({ demo: true })).map((u) => [u.id, u.isAdmin, u.demo]), [['zed', true, true]]);
  assert.equal(await s.getUser(null), null);
});

test(`${backend.name}: a saved turn reads back with every field; failed answers are not "recent"`, async () => {
  const s = await fixture(backend);
  const id = await s.addTurn({
    userId: 'me', conversationId: 'c', at: ago(1), question: 'q', rewritten: 'q2', intent: 'howto', topics: ['Abridge'],
    answer: 'a [1]', sources: [{ title: 'S' }], suggestions: ['next?'], confidence: 0.8, lowConfidence: true, mode: 'claude',
    latencyMs: 1200, assumptions: [{ text: "You're a nurse", fix: "I'm not a nurse" }],
  });
  const t = await s.getTurn(id);
  assert.deepEqual(
    [t.rewritten, t.intent, t.topics, t.sources, t.suggestions, t.confidence, t.lowConfidence, t.mode, t.latencyMs, t.assumptions],
    ['q2', 'howto', ['Abridge'], [{ title: 'S' }], ['next?'], 0.8, true, 'claude', 1200, [{ text: "You're a nurse", fix: "I'm not a nurse" }]],
  );
  await s.addTurn({ userId: 'me', conversationId: 'c', at: ago(0), question: 'broke', error: 'TIMEOUT' });
  assert.deepEqual((await s.recentTurns('me')).map((x) => x.question), ['q']);
  assert.deepEqual((await s.getTurn(await s.addTurn({ userId: 'me', conversationId: 'c', question: 'bare' }))).assumptions, []);
  assert.ok(!await s.getTurn(9999), 'no such turn');
});

test(`${backend.name}: normalized questions ignore case and punctuation`, async () => {
  assert.equal(normalizeQuestion('  Where is the HELP desk?!  '), 'where is the help desk');
});

test(`${backend.name}: pushed content: edits keep the row, and future start dates wait`, async () => {
  const s = await fixture(backend);
  const p = await s.savePromotion({ title: 'Old title', prompt: 'p', roles: ['nurse'] }, 'admin1');
  assert.equal(p.createdBy, 'admin1');
  const edited = await s.savePromotion({ ...p, title: 'New title', priority: 3 });
  assert.equal(edited.id, p.id);
  assert.deepEqual([edited.title, edited.priority, edited.roles], ['New title', 3, ['nurse']]);
  assert.equal((await s.listPromotions()).length, 1);
  await s.savePromotion({ title: 'Later', prompt: 'p', starts: '2999-01-01' });
  assert.deepEqual((await s.promotionsFor('nurse')).map((x) => x.title), ['New title']);
  assert.deepEqual(await s.promotionsFor('physician'), []);
});

test(`${backend.name}: insights: questions per day, role and topic, and the sources people opened`, async () => {
  const s = await fixture(backend);
  const a = await s.addTurn({ userId: 'me', conversationId: 'c', at: ago(1), question: 'q1', topics: ['Abridge', 'Training'] });
  await s.addTurn({ userId: 'doc', conversationId: 'd', at: ago(1), question: 'q2', topics: ['Abridge'] });
  await s.addTurn({ userId: 'ghost', conversationId: 'e', at: ago(2), question: 'q3', topics: [], error: 'TIMEOUT' });
  await s.addTurn({ userId: 'me', conversationId: 'old', at: ago(60), question: 'too old', topics: [] });
  await s.addEvent({ userId: 'me', type: 'citation_click', turnId: a, ref: 'x', data: { title: 'Abridge FAQ', kind: 'faq', url: 'u' } });
  await s.addEvent({ userId: 'doc', type: 'citation_click', ref: 'Abridge FAQ' });
  const i = await s.insights({ days: 30 });
  assert.equal(i.totals.questions, 3);
  assert.equal(i.totals.users, 3);
  assert.equal(i.totals.errors, 1);
  assert.deepEqual(i.byDay.map((d) => d.count).reduce((x, y) => x + y), 3);
  assert.deepEqual(i.byRole.map((r) => `${r.role}:${r.count}`).sort(), ['nurse:1', 'physician:1', 'unknown:1'], 'no role on file counts as unknown');
  assert.deepEqual(i.topics[0], { topic: 'Abridge', count: 2 });
  assert.deepEqual(i.topicRole.find((x) => x.topic === 'Training'), { topic: 'Training', role: 'nurse', count: 1 });
  assert.deepEqual(i.opened, [{ title: 'Abridge FAQ', kind: 'faq', url: 'u', count: 2 }]);
  assert.equal(i.trouble.find((t) => t.question === 'q3').reasons[0], 'error');
  assert.equal(i.demoData, false);
});

test(`${backend.name}: insights: a quick follow-up after opening a source is not "asked again"`, async () => {
  const s = await fixture(backend);
  const a = await s.addTurn({ userId: 'me', conversationId: 'c', at: ago(1), question: 'Haiku setup', topics: ['Haiku & Canto'] });
  await s.addTurn({ userId: 'me', conversationId: 'c', at: ago(1, 1), question: 'Haiku on Android', topics: ['Haiku & Canto'] });
  await s.addEvent({ userId: 'me', type: 'citation_click', turnId: a, ref: 'x' });
  assert.equal((await s.insights()).totals.rephrased, 0);
  // Ten minutes apart is a new question, not a rephrase.
  await s.addTurn({ userId: 'doc', conversationId: 'd', at: ago(1), question: 'Abridge', topics: ['Abridge'] });
  await s.addTurn({ userId: 'doc', conversationId: 'd', at: ago(1, 10), question: 'Abridge again', topics: ['Abridge'] });
  assert.equal((await s.insights()).totals.rephrased, 0);
});

test(`${backend.name}: demo data is flagged in insights and cleared without touching real data`, async () => {
  const s = await fixture(backend);
  await s.saveUser('demo1', { role: 'nurse', demo: true });
  await s.addTurn({ userId: 'demo1', conversationId: 'x', question: 'demo q', demo: true });
  await s.addTurn({ userId: 'me', conversationId: 'y', question: 'real q' });
  await s.addEvent({ userId: 'demo1', type: 'history_open', demo: true });
  await s.savePromotion({ title: 'Demo promo', prompt: 'p', demo: true });
  assert.equal((await s.insights()).demoData, true);
  await s.clearDemo();
  assert.equal((await s.insights()).demoData, false);
  assert.equal(await s.getUser('demo1'), null);
  assert.equal((await s.insights()).totals.questions, 1);
  assert.equal((await s.listPromotions()).length, 0);
  assert.ok(await s.getUser('me'));
});

}
