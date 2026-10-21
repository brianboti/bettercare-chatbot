// Covers: Personalization: what Sophia is told about the person, which suggestion cards they're offered (pushed content, their own history, people in their role, news), and the welcome screen with and without the AI model.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'LLM_DISABLED', 'LLM_PRIMARY']) delete process.env[k];
const { openStore } = await import('../server/store.mjs');
const { describePerson, welcomeCandidates, welcome } = await import('../server/personalize.mjs');
const llm = await import('../server/llm.mjs');

const ago = (days, mins = 0) => new Date(Date.now() - days * 86_400_000 + mins * 60_000).toISOString();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const chicagoDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });

let n = 0;
function fixture({ role = 'nurse', name = 'Rosa Diaz' } = {}) {
  const s = openStore(':memory:');
  const id = `user-${++n}`;       // the welcome cache is per user id, so each test gets a new one
  const user = s.saveUser(id, { name, role });
  s.saveUser(`${id}-peer1`, { role });
  s.saveUser(`${id}-peer2`, { role });
  return { s, user };
}

const news = (title, date, text = '', kind = 'news') => ({ id: title, kind, title, text, meta: { date } });
const noFacts = { context: () => ({ next: null }) };

beforeEach((t) => {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
  llm._setClientsForTest();
  t.mock.method(console, 'warn', () => {});
});

test('describePerson: no person, nothing to say', async () => {
  assert.equal(await describePerson(openStore(':memory:'), null), '');
});

test('describePerson: name, role, department, and that it is their first conversation', async () => {
  const { s } = fixture();
  const u = s.saveUser('x', { name: 'Sam', role: 'frontdesk', department: 'Clinic 4' });
  assert.equal(await describePerson(s, u), 'Name: Sam\nRole: Front desk & scheduling, Clinic 4\nFirst conversation with Sophia.');
  const noRole = s.saveUser('y', {});
  assert.equal(await describePerson(s, noRole), 'Role: not given\nFirst conversation with Sophia.');
});

test('describePerson: recent topics with counts, and their last questions', async () => {
  const { s, user } = fixture();
  const at = ago(2);
  s.addTurn({ userId: user.id, conversationId: 'c', at, question: 'How do I set up Haiku?', topics: ['Haiku & Canto'] });
  s.addTurn({ userId: user.id, conversationId: 'c', at, question: 'q'.repeat(300), topics: ['Haiku & Canto'] });
  const text = await describePerson(s, user);
  assert.match(text, new RegExp(`Asked about recently: Haiku & Canto \\(2×, last ${chicagoDay(at)}\\)`));
  assert.match(text, /Last questions:\n- .+: q{160}\n- .+: How do I set up Haiku\?$/);
});

test('cards: pushed content for their role first, at most 2, and not again once acted on', async () => {
  const { s, user } = fixture();
  const a = s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', blurb: 'New episode', roles: [], url: 'https://example.org/p', priority: 5 });
  s.savePromotion({ title: 'Nurses only', prompt: 'p', roles: ['nurse'] });
  s.savePromotion({ title: 'Third', prompt: 'p', roles: [] });
  s.savePromotion({ title: 'Surgeons only', prompt: 'p', roles: ['surgeon'] });
  let c = (await welcomeCandidates(s, user, { chunks: [], facts: noFacts }));
  assert.equal(c.filter((x) => x.source === 'org').length, 2);
  assert.ok(!c.some((x) => x.title === 'Surgeons only'));
  const pod = c.find((x) => x.promoId === a.id);
  assert.deepEqual([pod.id, pod.detail, pod.prompt, pod.url], [`org:${a.id}`, 'New episode', 'Summarize it', 'https://example.org/p']);
  s.addEvent({ userId: user.id, type: 'promo_dismiss', ref: String(a.id) });
  c = (await welcomeCandidates(s, user, { chunks: [], facts: noFacts }));
  assert.ok(!c.some((x) => x.promoId === a.id));
});

test('cards: build on their most asked topic, and on what people in their role ask', async () => {
  const { s, user } = fixture();
  s.addTurn({ userId: user.id, conversationId: 'c', at: ago(1), question: 'Abridge on my phone?', topics: ['Abridge'] });
  s.addTurn({ userId: `${user.id}-peer1`, conversationId: 'p', at: ago(1), question: 'How do I chart a flowsheet?', topics: ['Nursing'] });
  s.addTurn({ userId: `${user.id}-peer2`, conversationId: 'q', at: ago(1), question: 'How do I chart a flowsheet', topics: ['Nursing'] });
  const c = (await welcomeCandidates(s, user, { chunks: [], facts: noFacts }));
  const cont = c.find((x) => x.source === 'continue');
  assert.equal(cont.title, 'Abridge');
  assert.match(cont.detail, /asked about Abridge 1 time,/);
  assert.equal(cont.prompt, 'What else should I know about Abridge now that I\'ve looked into "Abridge on my phone?"?');
  const peer = c.find((x) => x.source === 'peers');
  assert.equal(peer.prompt, peer.title);
  assert.match(peer.detail, /^2 other Nurse asked this recently\.$/);
});

test('cards: the next Epic upgrade, worded for their role', async () => {
  const { s, user } = fixture();
  const facts = { context: () => ({ next: { version: 'vMay2026', date: '2026-05-02' } }) };
  const up = (await welcomeCandidates(s, user, { chunks: [], facts })).find((x) => x.id === 'new:upgrade:vMay2026');
  assert.equal(up.prompt, "What's changing for nurse in the vMay2026 upgrade?");
  const noRole = s.saveUser('nr', { role: 'unknown-role' });
  assert.equal((await welcomeCandidates(s, noRole, { chunks: [], facts })).find((x) => x.source === 'new').prompt, "What's changing for me in the vMay2026 upgrade?");
  assert.equal((await welcomeCandidates(s, user, { chunks: [], facts: null })).length, 0, 'no facts, no upgrade card');
});

test('cards: recent news and upcoming events that fit their role, best 3; podcasts always count', async () => {
  const { s, user } = fixture();
  const chunks = [
    news('Nursing flowsheet changes', day(-5), 'New nursing flowsheet rows'),
    news('Nursing flowsheet changes', day(-5), 'second chunk of the same post'),
    news('Nursing training class', day(10), 'Thrive training for nurses', 'event'),
    news('Old nursing news', day(-200), 'nursing'),
    news('Past nursing event', day(-3), 'nursing', 'event'),
    news('Far-off nursing event', day(120), 'nursing', 'event'),
    news("Dr. Sankary's podcast", day(-2), 'Listen now'),
    news('Pharmacy only', day(-1), 'Willow pharmacy'),
    { id: 'p', kind: 'page', title: 'Nursing page', text: 'nursing', meta: { date: day(-1) } },
    news('Undated nursing', '', 'nursing'),
  ];
  const got = (await welcomeCandidates(s, user, { chunks, facts: noFacts })).filter((x) => x.source === 'new');
  assert.deepEqual(got.map((x) => x.title).sort(), ["Dr. Sankary's podcast", 'Nursing flowsheet changes', 'Nursing training class']);
  const ev = got.find((x) => x.title === 'Nursing training class');
  assert.equal(ev.prompt, `Tell me about "Nursing training class" on ${day(10)}.`);
  assert.match(ev.detail, /^Upcoming event /);
  assert.equal(got.find((x) => x.title === "Dr. Sankary's podcast").prompt, `Summarize "Dr. Sankary's podcast".`);
});

test('welcome without the AI model: plain cards and a greeting by first name', async () => {
  const { s, user } = fixture();
  s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', roles: [] });
  s.addTurn({ userId: user.id, conversationId: 'c', at: ago(1), question: 'Abridge?', topics: ['Abridge'] });
  const w = await welcome(s, user, { chunks: [], facts: noFacts });
  assert.equal(w.greeting, 'Welcome back, Rosa. What can I find for you?');
  assert.deepEqual(w.cards.map((c) => [c.source, c.lead, c.label]), [['org', 'New', 'Podcast'], ['continue', 'For you', 'Abridge']]);
  const anon = s.saveUser('anon', { role: 'nurse' });
  assert.equal((await welcome(s, anon, { chunks: [], facts: noFacts })).greeting, 'What can I find for you today?');
});

test('welcome with the AI model: it phrases the cards, but only for real candidates', async () => {
  const { s, user } = fixture();
  const p = s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', roles: [], url: 'https://example.org/p' });
  process.env.ANTHROPIC_API_KEY = 'k';
  const requests = [];
  llm._setClientsForTest({ anthropic: { beta: { messages: { create: async (req) => {
    requests.push(req);
    return { model: 'claude-opus-5', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      greeting: `Hi Rosa${'!'.repeat(200)}`,
      cards: [
        { id: `org:${p.id}`, label: "Want the 2-minute version of Dr. Sankary's podcast?", prompt: '' },
        { id: 'made-up', label: 'Invented', prompt: 'Invented' },
      ],
    }) }] };
  } } } } });
  const w = await welcome(s, user, { chunks: [], facts: noFacts });
  assert.equal(w.greeting.length, 140);
  assert.deepEqual(w.cards, [{ id: `org:${p.id}`, source: 'org', lead: 'New', label: "Want the 2-minute version of Dr. Sankary's podcast?", prompt: 'Summarize it', promoId: p.id, url: 'https://example.org/p' }]);
  assert.match(requests[0].messages[0].content, /<person>\nName: Rosa Diaz/);
  assert.match(requests[0].messages[0].content, /"default_prompt":"Summarize it"/);
});

test('welcome is cached until they ask something new, and falls back to plain cards if the model fails', async () => {
  const { s, user } = fixture();
  s.savePromotion({ title: 'Podcast', prompt: 'Summarize it', roles: [] });
  process.env.ANTHROPIC_API_KEY = 'k';
  let calls = 0;
  llm._setClientsForTest({ anthropic: { beta: { messages: { create: async () => { calls++; throw new Error('boom'); } } } } });
  const first = await welcome(s, user, { chunks: [], facts: noFacts });
  assert.equal(first.cards[0].label, 'Podcast', 'plain card after a failure');
  assert.equal(await welcome(s, user, { chunks: [], facts: noFacts }), first, 'same object from the cache');
  assert.equal(calls, 1);
  s.addTurn({ userId: user.id, conversationId: 'c', question: 'New question', topics: [] });
  await welcome(s, user, { chunks: [], facts: noFacts });
  assert.equal(calls, 2, 'a new question rebuilds it');
});
