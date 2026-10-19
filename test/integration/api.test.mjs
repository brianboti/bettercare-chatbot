// Covers: Every HTTP route of the real server, started on its own with a throwaway database and no AI model: health, search, profiles, welcome, history, feedback, events, admin pages, the chat stream, CORS, static files and blocked path tricks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, chat, ROOT } from './server.mjs';
import { SUITES } from '../../server/testrunner.mjs';

const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const HAS_SITE = existsSync(resolve(ROOT, 'data/site/snapshots'));

let srv, url;
before(async () => {
  srv = await startServer({
    env: { RATE_LIMIT_MESSAGES: '4' },
    seed: (s) => {
      s.saveUser('it-admin', { name: 'Ada Admin', role: 'it', isAdmin: true });
      s.saveUser('it-nurse', { name: 'Nina Nurse', role: 'nurse' });
      s.saveUser('it-other', { name: 'Oscar Other', role: 'nurse' });
      s.saveUser('it-norole', { name: 'No Role' });
      s.saveUser('demo-ann', { name: 'Ann Demo', role: 'lab', demo: true });
      s.saveUser('peer-x', { role: 'lab', demo: true });
      s.savePromotion({ title: 'Nursing flowsheet changes', blurb: 'What changed', prompt: 'What changed in nursing flowsheets?', roles: ['nurse'], priority: 5, active: true, url: 'https://example.org/flowsheets' }, 'it-admin');
    },
  });
  url = srv.url;
});
after(async () => { await srv?.stop(); });

const get = (path, user, headers = {}) => fetch(`${url}${path}`, { headers: { ...(user ? { 'X-Sophia-User': user } : {}), ...headers } });
const post = (path, body, user) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Sophia-User': user } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json() });

/** One retrieval-only answer saved to `user`'s history; returns the done event. */
async function ask(user, q, conversationId) {
  const r = await chat(url, { messages: [{ role: 'user', content: q }], conversationId }, { user });
  assert.equal(r.status, 200);
  const done = r.events.find(([e]) => e === 'done');
  assert.ok(done, `no done event: ${JSON.stringify(r.events)}`);
  return { ...r, done: done[1] };
}

// ---------------------------------------------------------------- health, search

test('health reports the version, retrieval-only mode and the corpus', async () => {
  const { status, body } = await json(await get('/api/health'));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, VERSION);
  assert.equal(body.mode, 'retrieval-only');
  assert.equal(body.model, null);
  assert.deepEqual(body.providers, { primary: null, backup: null, claudeSkippedUntil: null });
  assert.ok(body.chunks > 1000 && body.sources > 100);
  assert.match(body.promptVersion, /^bc-/);
});

test('search returns numbered sources, clamps k, and answers an empty query with nothing', async () => {
  const empty = await json(await get('/api/search?q=%20%20'));
  assert.deepEqual(empty.body, { query: '', results: [], ms: 0 });

  const { status, body } = await json(await get('/api/search?q=Abridge%20ambient%20listening&k=5'));
  assert.equal(status, 200);
  assert.equal(body.results.length, 5);
  assert.deepEqual(body.results.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.ok(body.results.some((r) => /abridge/i.test(r.title + r.snippet)), 'an Abridge source comes back');
  assert.equal(typeof body.confidence, 'number');
  for (const r of body.results) assert.ok(r.title && r.url && typeof r.snippet === 'string');

  const big = await json(await get('/api/search?q=training&k=500'));
  assert.ok(big.body.results.length <= 30, 'k is capped at 30');
  const zero = await json(await get('/api/search?q=training&k=0'));
  assert.ok(zero.body.results.length >= 1 && zero.body.results.length <= 10, 'k=0 falls back to the default of 10');
});

test('classic search needs every word as typed, and treats regex characters literally', async () => {
  const { body } = await json(await get('/api/classic-search?q=abridge'));
  assert.ok(body.results.length > 0 && body.results.length <= 20);
  for (const r of body.results) assert.ok(r.title && r.url);
  assert.deepEqual((await json(await get('/api/classic-search?q='))).body, { results: [] });
  assert.deepEqual((await json(await get('/api/classic-search?q=abridge%20zzqqxxnotaword'))).body, { results: [] });
  const regex = await get('/api/classic-search?q=%5B(*');
  assert.equal(regex.status, 200, 'a query like "[(*" is not a regex error');
});

// ---------------------------------------------------------------- people

test('me: anonymous, saving a profile, and refusing bad input', async () => {
  const anon = await json(await get('/api/me'));
  assert.equal(anon.body.user, null);
  assert.ok(anon.body.roles.some((r) => r.key === 'nurse' && r.label === 'Nurse'));

  const bad = await json(await get('/api/me', 'not a valid id!'));
  assert.equal(bad.body.user, null, 'a header with spaces or symbols is ignored');

  assert.equal((await post('/api/me', { name: 'X' })).status, 400, 'saving needs the header');
  const badRole = await json(await post('/api/me', { role: 'astronaut' }, 'it-new'));
  assert.equal(badRole.status, 400);
  assert.equal(badRole.body.code, 'BAD_REQUEST');
  assert.equal((await post('/api/me', '{not json', 'it-new')).status, 400);

  const saved = await json(await post('/api/me', { name: '  Pat Lee  ', role: 'pharmacy', department: 'Inpatient', email: 'pat@example.org' }, 'It-New'));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.user.id, 'it-new', 'the id is lowercased');
  assert.deepEqual([saved.body.user.name, saved.body.user.role, saved.body.user.department], ['Pat Lee', 'pharmacy', 'Inpatient']);
  const again = await json(await get('/api/me', 'it-new'));
  assert.equal(again.body.user.role, 'pharmacy');
  const later = await json(await get('/api/me', 'it-new'));
  assert.ok(later.body.user.lastSeenAt, 'a visit is recorded (shown from the next request on)');
});

test('demo users: the switcher lists demo people only, without peer filler', async () => {
  const { body } = await json(await get('/api/demo-users'));
  const ids = body.users.map((u) => u.id);
  assert.ok(ids.includes('demo-ann'));
  assert.ok(!ids.includes('peer-x') && !ids.includes('it-nurse'));
  assert.deepEqual(Object.keys(body.users[0]).sort(), ['department', 'id', 'isAdmin', 'name', 'role']);
});

test('welcome: onboarding without a role; greeting and cards (with pushed content) with one', async () => {
  assert.equal((await json(await get('/api/welcome'))).body.needsOnboarding, true);
  assert.equal((await json(await get('/api/welcome', 'it-norole'))).body.needsOnboarding, true);
  const { status, body } = await json(await get('/api/welcome', 'it-nurse'));
  assert.equal(status, 200);
  assert.match(body.greeting, /Nina/);
  assert.ok(body.cards.length >= 1 && body.cards.length <= 4);
  const promo = body.cards.find((c) => c.promoId);
  assert.ok(promo, 'the nurse sees the promotion pushed to nurses');
  assert.equal(promo.url, 'https://example.org/flowsheets');
  for (const c of body.cards) assert.ok(c.label && c.prompt && c.lead);
});

// ---------------------------------------------------------------- chat

test('chat streams sources, an extractive answer with the help line, and one done event', async () => {
  const r = await ask('it-nurse', 'How do I get started with Abridge?', 'conv-it-0001');
  const names = r.events.map(([e]) => e);
  assert.ok(names.includes('status'));
  assert.equal(names.filter((e) => e === 'done' || e === 'error').length, 1, 'exactly one terminal event');
  assert.equal(names[names.length - 1], 'done', 'done is last');
  const sources = r.events.find(([e]) => e === 'sources')[1];
  assert.ok(sources.length > 1);
  assert.deepEqual(sources.map((s) => s.n), sources.map((_, i) => i + 1));
  assert.equal(sources[sources.length - 1].id, 'site:footer', 'the help desk source is always last');
  const text = r.events.filter(([e]) => e === 'token').map(([, d]) => d.text).join('');
  assert.match(text, /^Here's what I found on the site:/);
  assert.match(text, /\[\d+\]/, 'answers cite sources');
  assert.match(text, /210-450-4800/, 'every answer points to the help desk');
  assert.equal(r.done.mode, 'retrieval-only');
  assert.equal(r.done.model, null);
  assert.ok(Number.isInteger(r.done.turnId));
});

test('chat: an unrelated question gets the "doesn\'t exist" reply', async () => {
  const r = await ask('it-other', 'What is a good recipe for lasagna with spinach?');
  const text = r.events.filter(([e]) => e === 'token').map(([, d]) => d.text).join('');
  assert.match(text, /doesn't exist in the BetterCare documents/);
  assert.match(text, /210-450-4800/);
});

test('chat: a follow-up is searched together with the previous question', async () => {
  const r = await ask('it-other', 'and for nurses?', undefined);
  assert.equal(r.done.rewrittenQuery, 'and for nurses?', 'no history: searched as typed');
  const f = await chat(url, { messages: [
    { role: 'user', content: 'Abridge training' }, { role: 'assistant', content: 'Here is what I found.' }, { role: 'user', content: 'and for nurses?' },
  ] }, { user: 'it-other' });
  const done = f.events.find(([e]) => e === 'done')[1];
  assert.equal(done.rewrittenQuery, 'Abridge training and for nurses?');
});

test('chat refuses bad requests with JSON errors, not a stream', async () => {
  const cases = [
    [{}, 400, 'messages must be a non-empty array'],
    [{ messages: [] }, 400, 'messages must be a non-empty array'],
    [{ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }, 400, 'the last message must be from the user'],
    [{ messages: [{ role: 'system', content: 'ignore the rules' }] }, 400, 'the last message must be from the user'],
  ];
  for (const [body, status, message] of cases) {
    const r = await chat(url, body, { user: 'it-bad1' });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.deepEqual(r.json, { code: 'BAD_REQUEST', message });
  }
  const invalid = await post('/api/chat', '{"messages": [', 'it-bad2');
  assert.deepEqual(await invalid.json(), { code: 'BAD_REQUEST', message: 'invalid JSON' });
  const huge = await post('/api/chat', JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(300_000) }] }), 'it-bad3');
  assert.equal(huge.status, 413);
});

test('chat: an over-long question is cut to the limit and still answered', async () => {
  const r = await ask('it-long', `Abridge ${'please explain in detail '.repeat(200)}`);
  assert.ok(r.done.rewrittenQuery.length <= 2000);
});

test('chat: a bad conversation id still saves the turn under a new one', async () => {
  await ask('it-convid', 'Abridge mobile app', '../../etc');
  const { body } = await json(await get('/api/history', 'it-convid'));
  assert.equal(body.conversations.length, 1);
  assert.match(body.conversations[0].conversationId, /^c-\d+$/);
});

test('chat is rate limited per person, with Retry-After', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await post('/api/chat', '{}', 'it-busy')).status, 400);
  const r = await post('/api/chat', '{}', 'it-busy');
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.equal(body.code, 'RATE_LIMITED');
  assert.ok(Number(r.headers.get('retry-after')) > 0 && body.retryAfter > 0);
  assert.equal((await post('/api/chat', '{}', 'it-calm')).status, 400, 'other people are not affected');
});

// ---------------------------------------------------------------- history, feedback

test('history: list, one conversation, and only your own', async () => {
  await ask('it-hist', 'Abridge training', 'conv-hist-a');
  await ask('it-hist', 'Haiku app for iPhone', 'conv-hist-b');
  const list = await json(await get('/api/history', 'it-hist'));
  assert.deepEqual(list.body.conversations.map((c) => c.conversationId).sort(), ['conv-hist-a', 'conv-hist-b']);
  const one = await json(await get('/api/history/conv-hist-a', 'it-hist'));
  assert.equal(one.body.turns.length, 1);
  assert.equal(one.body.turns[0].question, 'Abridge training');
  assert.ok(one.body.turns[0].answer && one.body.turns[0].sources.length);

  assert.deepEqual((await json(await get('/api/history/conv-hist-a', 'it-admin'))).body.turns, [], "someone else's conversation is empty");
  assert.deepEqual((await json(await get('/api/history'))).body, { conversations: [] }, 'no one signed in: no history');
});

test('history remove: one conversation, then all; never someone else\'s', async () => {
  await ask('it-rm', 'Abridge training', 'conv-rm-a');
  await ask('it-rm', 'Haiku app', 'conv-rm-b');
  assert.equal((await post('/api/history/remove', {}, 'it-rm')).status, 400, 'needs conversationId or all');
  assert.equal((await post('/api/history/remove', { conversationId: 'conv-rm-a' })).status, 400, 'needs a person');
  assert.equal((await json(await post('/api/history/remove', { conversationId: 'conv-rm-a' }, 'it-admin'))).body.removed, 0);
  assert.equal((await json(await post('/api/history/remove', { conversationId: 'conv-rm-a' }, 'it-rm'))).body.removed, 1);
  assert.deepEqual((await json(await get('/api/history', 'it-rm'))).body.conversations.map((c) => c.conversationId), ['conv-rm-b']);
  assert.deepEqual((await json(await get('/api/history/conv-rm-a', 'it-rm'))).body.turns, []);
  assert.equal((await json(await post('/api/history/remove', { all: true }, 'it-rm'))).body.removed, 1);
  assert.deepEqual((await json(await get('/api/history', 'it-rm'))).body.conversations, []);
});

test('feedback: rate, comment, clear; only on your own answers', async () => {
  const { done } = await ask('it-fb', 'Abridge training', 'conv-fb-1');
  const id = done.turnId;
  assert.deepEqual((await json(await post('/api/feedback', { turnId: id, value: -1, note: '  Missing the iPad steps  ' }, 'it-fb'))).body, { ok: true });
  let turn = (await json(await get('/api/history/conv-fb-1', 'it-fb'))).body.turns[0];
  assert.deepEqual([turn.feedback, turn.feedbackNote], [-1, 'Missing the iPad steps']);

  assert.equal((await post('/api/feedback', { turnId: id, value: 0, note: 'ignored' }, 'it-fb')).status, 200);
  turn = (await json(await get('/api/history/conv-fb-1', 'it-fb'))).body.turns[0];
  assert.deepEqual([turn.feedback, turn.feedbackNote], [null, null], '0 clears the rating and the note');

  assert.equal((await post('/api/feedback', { turnId: id, value: 1 }, 'it-admin')).status, 404, "can't rate someone else's answer");
  assert.equal((await post('/api/feedback', { turnId: 99999999, value: 1 }, 'it-fb')).status, 404);
  for (const bad of [{ turnId: id }, { turnId: String(id), value: 1 }, { turnId: id, value: 'up' }, { turnId: 1.5, value: 1 }]) {
    assert.equal((await post('/api/feedback', bad, 'it-fb')).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/api/feedback', { turnId: id, value: 1 })).status, 400, 'needs a person');
});

test('events: known types are recorded, anything else refused', async () => {
  assert.deepEqual((await json(await post('/api/events', { type: 'citation_click', ref: 'x'.repeat(1000), data: { n: 2 } }, 'it-nurse'))).body, { ok: true });
  assert.equal((await post('/api/events', { type: 'copy_answer' })).status, 200, 'anonymous events are fine');
  const bad = await json(await post('/api/events', { type: 'drop_table' }, 'it-nurse'));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.message, 'unknown event type');
});

// ---------------------------------------------------------------- admin

test('admin routes are for admins only', async () => {
  for (const path of ['/api/admin/insights', '/api/admin/tests', '/api/admin/promotions']) {
    for (const user of [undefined, 'it-nurse']) {
      const r = await json(await get(path, user));
      assert.equal(r.status, 403, `${path} as ${user}`);
      assert.deepEqual(r.body, { code: 'FORBIDDEN', message: 'Admins only.' });
    }
  }
  assert.equal((await post('/api/admin/tests/run', { suite: 'unit' }, 'it-nurse')).status, 403);
  assert.equal((await post('/api/admin/promotions', { title: 'x', prompt: 'y' }, 'it-nurse')).status, 403);
});

test('admin insights: totals, roles, days and role filters', async () => {
  const { status, body } = await json(await get('/api/admin/insights?days=9999&role=nurse', 'it-admin'));
  assert.equal(status, 200);
  assert.equal(body.days, 365, 'days capped at a year');
  assert.equal(body.role, 'nurse');
  assert.ok(body.totals.questions >= 1);
  assert.ok(body.roles.length >= 9);
  const promo = body.promotions.find((p) => p.title === 'Nursing flowsheet changes');
  assert.ok(promo.shown >= 1, 'showing a welcome card counts as shown');
  const bogus = await json(await get('/api/admin/insights?days=-3&role=astronaut', 'it-admin'));
  assert.deepEqual([bogus.body.days, bogus.body.role], [1, null]);
});

test('admin tests: suites listed; an unknown suite is refused without running anything', async () => {
  const { body } = await json(await get('/api/admin/tests', 'it-admin'));
  assert.deepEqual(body.suites.map((s) => s.key), SUITES.map((s) => s.key));
  for (const k of ['unit', 'integration', 'e2e', 'retrieval', 'scope', 'answers']) assert.ok(body.suites.some((s) => s.key === k), k);
  const r = await json(await post('/api/admin/tests/run', { suite: 'rm -rf /' }, 'it-admin'));
  assert.equal(r.status, 400);
});

test('admin promotions: list, create, update, validation', async () => {
  const list = await json(await get('/api/admin/promotions', 'it-admin'));
  assert.ok(list.body.promotions.some((p) => p.title === 'Nursing flowsheet changes'));

  const made = await json(await post('/api/admin/promotions', { title: '  Beaker tips ', prompt: 'Show me Beaker tips', roles: ['lab', 'astronaut'], starts: '2026-01-01', ends: 'soon', url: 'https://example.org/beaker' }, 'it-admin'));
  assert.equal(made.status, 200);
  const p = made.body.promotion;
  assert.equal(p.title, 'Beaker tips');
  assert.deepEqual(p.roles, ['lab'], 'unknown roles dropped');
  assert.deepEqual([p.starts, p.ends], ['2026-01-01', null], 'bad dates dropped');

  const updated = await json(await post('/api/admin/promotions', { id: p.id, title: 'Beaker tips v2', prompt: 'Show me Beaker tips', active: false }, 'it-admin'));
  assert.equal(updated.body.promotion.id, p.id);
  assert.equal(updated.body.promotion.title, 'Beaker tips v2');

  assert.equal((await post('/api/admin/promotions', { title: '', prompt: 'x' }, 'it-admin')).status, 400);
  assert.equal((await post('/api/admin/promotions', { title: 'x' }, 'it-admin')).status, 400);
  const http = await json(await post('/api/admin/promotions', { title: 'x', prompt: 'y', url: 'http://example.org' }, 'it-admin'));
  assert.equal(http.status, 400);
  assert.match(http.body.message, /https:\/\//);
});

// ---------------------------------------------------------------- CORS, static files, 404

test('CORS: the extension, localhost and SharePoint are allowed; other sites are not', async () => {
  for (const origin of ['chrome-extension://abcdef', 'http://localhost:3000', 'http://127.0.0.1', 'https://uthealthsa.sharepoint.com']) {
    const r = await fetch(`${url}/api/chat`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.match(r.headers.get('access-control-allow-headers'), /X-Sophia-User/);
  }
  for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'https://uthealthsa.sharepoint.com.evil.example']) {
    const r = await fetch(`${url}/api/health`, { headers: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
  }
});

test('static files: the shared client library and the admin panel, with HEAD and byte ranges', async () => {
  const lib = await get('/lib/chat-api.js');
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /text\/javascript/);
  assert.match(await lib.text(), /export async function streamChat/);

  for (const path of ['/admin', '/admin/']) {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  }
  assert.match(await (await get('/admin/admin.js')).text(), /function/);

  const head = await fetch(`${url}/lib/render.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 100);

  const part = await get('/lib/render.js', null, { Range: 'bytes=0-9' });
  assert.equal(part.status, 206);
  assert.match(part.headers.get('content-range'), /^bytes 0-9\/\d+$/);
  assert.equal((await part.text()).length, 10);
});

test('path tricks cannot read files outside the served folders', async () => {
  for (const path of ['/lib/..%2f..%2fpackage.json', '/lib/..%2f..%2f.env', '/admin/..%2f..%2f..%2fpackage.json', '/lib/%2e%2e%2f%2e%2e%2fserver%2fconfig.mjs']) {
    const r = await get(path);
    assert.ok([403, 404].includes(r.status), `${path} → ${r.status}`);
    assert.doesNotMatch(await r.text(), /"name": "sophia|ANTHROPIC|process\.env/, path);
  }
  assert.equal((await get('/lib/..%2f..%2fpackage.json')).status, 403);
  assert.equal((await get('/lib/%E0%A4%A')).status, 400, 'a malformed escape is a bad request, not a crash');
});

test('unknown routes are 404', async () => {
  const r = await get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(await r.text(), 'Not found');
  assert.equal((await get('/lib/nope.js')).status, 404);
});

// ---------------------------------------------------------------- the site replica (needs the export in data/site)

test('replica: home redirect, a page with the assistant, a missing page, and its support files', { skip: !HAS_SITE && 'data/site export not present' }, async () => {
  const root = await fetch(`${url}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/sites/BetterCare/SitePages/Home.aspx');

  const home = await get('/sites/BetterCare/SitePages/Home.aspx');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<script type="module" src="\/_replica\/assistant\.js"><\/script>/);

  const missing = await get('/sites/BetterCare/SitePages/Not-A-Real-Page.aspx');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /isn't in the local replica/);

  const site = await json(await get('/_replica/site.json'));
  assert.equal(typeof site.body.title, 'string');
  assert.ok(Array.isArray(site.body.nav));
  assert.equal((await get('/_replica/assistant.js')).status, 200);
  assert.match((await get('/_replica/chrome.css')).headers.get('content-type'), /text\/css/);
  assert.equal((await get('/_replica/..%2fserver.mjs')).status, 403, "the replica's own server code is not served");
});
