// Covers: The real server with sign-in turned on (AUTH_MODE=password, as deployed): everything but health and the sign-in page needs a session, password and SharePoint sign-in, the session cookie and the extension's token, sign-up, admin-only pages, sign-out, and the limit on sign-in attempts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const ADMIN_PASSWORD = 'admin-pass-1234';
let srv, url;
before(async () => {
  srv = await startServer({
    env: {
      AUTH_MODE: 'password', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD,
      ALLOW_SIGNUP: '1', SHAREPOINT_SIGNIN: '1', SHAREPOINT_EMAIL_DOMAINS: 'uthscsa.edu',
    },
  });
  url = srv.url;
});
after(async () => { await srv?.stop(); });

const req = (path, { body, cookie, token, headers = {}, method } = {}) => fetch(`${url}${path}`, {
  method: method || (body ? 'POST' : 'GET'),
  redirect: 'manual',
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  },
  body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
/** The name=value part of the session cookie a response set. */
const sessionCookie = (res) => res.headers.get('set-cookie')?.split(';')[0];

test('health and the sign-in options need no sign-in, and say how this server is set up', async () => {
  const h = await json(await req('/api/health'));
  assert.equal(h.status, 200);
  assert.equal(h.body.auth, 'password');
  assert.equal(h.body.database, process.env.TEST_DATABASE || 'sqlite');
  assert.deepEqual((await json(await req('/api/auth/config'))).body, { mode: 'password', methods: ['password', 'sharepoint'], signup: true });
  const page = await req('/signin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in to Sophia/);
});

test('without a session: pages go to the sign-in page, the API answers 401, the X-Sophia-User header counts for nothing', async () => {
  const page = await req('/admin');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/signin?next=%2Fadmin');
  for (const path of ['/api/me', '/api/search?q=abridge', '/api/history', '/api/welcome', '/api/admin/insights']) {
    const r = await json(await req(path));
    assert.deepEqual([path, r.status, r.body.code], [path, 401, 'SIGN_IN_REQUIRED']);
  }
  assert.equal((await req('/api/me', { headers: { 'X-Sophia-User': 'admin' } })).status, 401);
  const c = await req('/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(c.status, 401);
  assert.deepEqual((await json(await req('/api/demo-users', { cookie: 'x=1' }))).status, 401);
});

test('password sign-in: wrong password refused; right one sets an HttpOnly cookie that signs in the next requests', async () => {
  const bad = await json(await req('/api/auth/login', { body: { username: 'admin', password: 'nope-nope' } }));
  assert.deepEqual([bad.status, bad.body.code], [401, 'BAD_CREDENTIALS']);
  assert.equal(bad.headers.get('set-cookie'), null);

  const ok = await req('/api/auth/login', { body: { username: 'Admin', password: ADMIN_PASSWORD } });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.user.id, 'admin');
  assert.equal(body.user.isAdmin, true);
  assert.equal(body.token, undefined, 'the website gets no token, only the cookie');
  assert.match(ok.headers.get('set-cookie'), /^sophia_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

  const cookie = sessionCookie(ok);
  const me = await json(await req('/api/me', { cookie }));
  assert.deepEqual([me.body.user.id, me.body.signedInWith], ['admin', 'password']);
  assert.equal((await req('/api/admin/insights', { cookie })).status, 200);
  assert.equal((await req('/api/search?q=abridge', { cookie })).status, 200);
  assert.deepEqual((await json(await req('/api/demo-users', { cookie }))).body, { users: [] }, 'no demo switcher with real sign-in');
});

test('the extension asks for a token and sends it as Authorization: Bearer', async () => {
  const r = await json(await req('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD, token: true } }));
  assert.match(r.body.token, /^[\w-]{40,}$/);
  const chat = await req('/api/chat', { token: r.body.token, body: { messages: [{ role: 'user', content: 'How do I get Abridge?' }], conversationId: 'c-ext-1' } });
  assert.equal(chat.status, 200);
  const done = (await chat.text()).split('\n\n').find((e) => e.startsWith('event: done'));
  assert.ok(done, 'the answer finished');
  const hist = await json(await req('/api/history', { token: r.body.token }));
  assert.ok(hist.body.conversations.some((c) => c.conversationId === 'c-ext-1'), 'saved to their history');
});

test('CORS lets the extension send its token', async () => {
  const r = await req('/api/chat', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefghijklmnop', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(r.headers.get('access-control-allow-credentials'), null, 'cookies never go cross-site');
});

test('sign-up makes an ordinary account; it can ask but not open admin pages', async () => {
  const r = await req('/api/auth/signup', { body: { username: 'pat.lee', password: 'pat-password', name: 'Pat Lee' } });
  assert.equal(r.status, 200);
  const cookie = sessionCookie(r);
  const me = await json(await req('/api/me', { cookie }));
  assert.deepEqual([me.body.user.name, me.body.user.isAdmin], ['Pat Lee', false]);
  assert.equal((await req('/api/admin/insights', { cookie })).status, 403);
  assert.equal((await json(await req('/api/auth/signup', { body: { username: 'pat.lee', password: 'another-one' } }))).status, 409);
  assert.equal((await json(await req('/api/auth/signup', { body: { username: 'short', password: 'x' } }))).body.code, 'WEAK_PASSWORD');
});

test('SharePoint sign-in: an allowed work email gets a session and a token; others are refused', async () => {
  const r = await json(await req('/api/auth/sharepoint', { body: { email: 'Jane.Doe@uthscsa.edu', name: 'Jane Doe' } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, 'jane.doe@uthscsa.edu');
  const me = await json(await req('/api/me', { token: r.body.token }));
  assert.deepEqual([me.body.user.name, me.body.signedInWith], ['Jane Doe', 'sharepoint']);
  assert.equal((await json(await req('/api/auth/sharepoint', { body: { email: 'someone@gmail.com' } }))).status, 403);
  assert.equal((await json(await req('/api/auth/login', { body: { username: 'jane.doe@uthscsa.edu', password: 'anything-at-all' } }))).status, 401, 'no password sign-in for it');
});

test('sign-out ends the session and clears the cookie', async () => {
  const ok = await req('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  const cookie = sessionCookie(ok);
  const out = await req('/api/auth/logout', { cookie, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /^sophia_session=; .*Max-Age=0/);
  assert.equal((await req('/api/me', { cookie })).status, 401);
});

test('too many sign-in attempts for one account wait a while', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await req('/api/auth/login', { body: { username: 'target', password: `guess-${i}-xx` } });
  const r = await json(last);
  assert.deepEqual([r.status, r.body.code], [429, 'RATE_LIMITED']);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});
