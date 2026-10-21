// Covers: Sign-in: password hashing, session tokens and cookies, who a request is from, the demo password and SharePoint sign-ins, sign-up, and the startup admin account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuth, hashPassword, verifyPassword, tokenHash, readCookie, requestToken, SESSION_COOKIE, USERNAME,
} from '../server/auth.mjs';
import { BACKENDS } from './store-backends.mjs';

const CFG = {
  AUTH_MODE: 'password', SESSION_DAYS: 7, ALLOW_SIGNUP: false, SHAREPOINT_SIGNIN: false,
  SHAREPOINT_EMAIL_DOMAINS: ['uthscsa.edu'], ADMIN_USERNAME: '', ADMIN_PASSWORD: '', ADMIN_USERS: [], COOKIE_SECURE: false,
};
const req = (headers = {}) => ({ headers });
const bearer = (token) => req({ authorization: `Bearer ${token}` });

test('passwords: a hash verifies only the same password, and two hashes of one password differ', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('correct hors', h), false);
  assert.notEqual(await hashPassword('correct horse'), h);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', null), false);
});

test('tokens: a request carries one in Authorization: Bearer or in the session cookie', () => {
  const t = 'A'.repeat(43);
  assert.equal(requestToken(bearer(t)), t);
  assert.equal(requestToken(req({ cookie: `other=1; ${SESSION_COOKIE}=${t}` })), t);
  assert.equal(requestToken(req({ authorization: 'Bearer short' })), null, 'too short to be ours');
  assert.equal(requestToken(req({ cookie: `${SESSION_COOKIE}=bad value!` })), null);
  assert.equal(requestToken(req()), null);
  assert.equal(readCookie('a=1; b=two%20words', 'b'), 'two words');
  assert.equal(tokenHash('x').length, 64);
});

test('usernames: lowercase words with dots, dashes and underscores; no emails', () => {
  for (const ok of ['admin', 'jane.doe', 'sam_n', 'demo-1']) assert.ok(USERNAME.test(ok), ok);
  for (const bad of ['a', 'Jane', 'jane@uthscsa.edu', '.dot', 'has space', 'x'.repeat(65)]) assert.ok(!USERNAME.test(bad), bad);
});

test('cookie: HttpOnly, SameSite=Lax, whole site; Secure over HTTPS; clearing sets Max-Age=0', () => {
  const auth = createAuth({}, CFG);
  const c = auth.cookie('tok', { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.match(c, /^sophia_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=(3599|3600)$/);
  assert.match(auth.cookie('tok', { secure: true, expiresAt: new Date().toISOString() }), /; Secure$/);
  assert.match(auth.cookie(null), /^sophia_session=; .*Max-Age=0$/);
  assert.match(createAuth({}, { ...CFG, COOKIE_SECURE: true }).cookie(null), /; Secure$/);
});

test('header mode: X-Sophia-User says who, unchecked; no sign-in methods', async () => {
  const store = await BACKENDS[0].open();
  await store.saveUser('sam', { name: 'Sam' });
  const auth = createAuth(store, { ...CFG, AUTH_MODE: 'header' });
  assert.deepEqual(auth.publicConfig(), { mode: 'header', methods: [], signup: false });
  const who = await auth.identify(req({ 'x-sophia-user': ' SAM ' }));
  assert.equal(who.id, 'sam');
  assert.equal(who.user.name, 'Sam');
  assert.equal((await auth.identify(req({ 'x-sophia-user': 'new.person' }))).user, null, 'an unknown id has no user yet');
  assert.equal((await auth.identify(req({ 'x-sophia-user': 'bad id!' }))).id, null);
  assert.equal((await auth.identify(bearer('A'.repeat(43)))).id, null, 'tokens mean nothing here');
});

for (const backend of BACKENDS) {
  const setup = async (cfg = {}) => {
    const store = await backend.open();
    return { store, auth: createAuth(store, { ...CFG, ...cfg }) };
  };

  test(`${backend.name}: password sign-in starts a session the next request is known by; sign-out ends it`, async () => {
    const { store, auth } = await setup();
    await auth.setPassword('jane.doe', 'longenough', { name: 'Jane' });
    assert.equal(await auth.passwordLogin('jane.doe', 'wrong-password'), null);
    assert.equal(await auth.passwordLogin('nobody', 'longenough'), null);
    const user = await auth.passwordLogin(' Jane.Doe ', 'longenough');
    assert.equal(user.id, 'jane.doe');

    const { token, expiresAt } = await auth.startSession(user.id, 'password');
    assert.ok(Date.parse(expiresAt) > Date.now() + 6 * 86_400_000);
    const who = await auth.identify(bearer(token));
    assert.deepEqual([who.id, who.user.name, who.via], ['jane.doe', 'Jane', 'password']);
    assert.equal((await auth.identify(req({ cookie: `${SESSION_COOKIE}=${token}` }))).id, 'jane.doe');
    assert.equal(await store.getSession(token), null, 'only the hash of the token is stored');

    await auth.endSession(bearer(token));
    assert.equal((await auth.identify(bearer(token))).user, null);
    assert.equal((await auth.identify(req({ 'x-sophia-user': 'jane.doe' }))).id, null, 'the header means nothing in password mode');
  });

  test(`${backend.name}: an expired session is refused and removed`, async () => {
    const { store, auth } = await setup();
    await store.saveUser('old', {});
    const token = 'B'.repeat(43);
    await store.addSession({ tokenHash: tokenHash(token), userId: 'old', method: 'password', createdAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-08T00:00:00Z' });
    assert.equal((await auth.identify(bearer(token))).user, null);
    assert.equal(await store.getSession(tokenHash(token)), null);
  });

  test(`${backend.name}: accounts need a proper username and an 8-character password`, async () => {
    const { auth } = await setup();
    await assert.rejects(auth.setPassword('Jane Doe', 'longenough'), { code: 'BAD_USERNAME' });
    await assert.rejects(auth.setPassword('jane@uthscsa.edu', 'longenough'), { code: 'BAD_USERNAME' });
    await assert.rejects(auth.setPassword('jane', 'short'), { code: 'WEAK_PASSWORD' });
  });

  test(`${backend.name}: sign-up only when ALLOW_SIGNUP is on, and never over an existing account`, async () => {
    const closed = await setup();
    await assert.rejects(closed.auth.signup('pat', 'longenough'), { code: 'SIGNUP_CLOSED', status: 403 });
    const { auth } = await setup({ ALLOW_SIGNUP: true });
    assert.equal(auth.publicConfig().signup, true);
    const u = await auth.signup('pat', 'longenough', '  Pat Lee ');
    assert.equal(u.name, 'Pat Lee');
    assert.equal(u.isAdmin, false);
    await assert.rejects(auth.signup('pat', 'otherpassword'), { code: 'TAKEN', status: 409 });
    assert.ok(await auth.passwordLogin('pat', 'longenough'), 'the first password still works');
  });

  test(`${backend.name}: SharePoint sign-in only when turned on, and only for the allowed email domains`, async () => {
    const off = await setup();
    await assert.rejects(off.auth.sharepointLogin({ email: 'jane.doe@uthscsa.edu' }), { code: 'METHOD_OFF', status: 403 });
    const { auth } = await setup({ SHAREPOINT_SIGNIN: true });
    assert.deepEqual(auth.publicConfig().methods, ['password', 'sharepoint']);
    const u = await auth.sharepointLogin({ email: 'Jane.Doe@UTHSCSA.edu', name: 'Jane Doe' });
    assert.deepEqual([u.id, u.email, u.name], ['jane.doe@uthscsa.edu', 'jane.doe@uthscsa.edu', 'Jane Doe']);
    assert.equal((await auth.sharepointLogin({ email: 'jane.doe@uthscsa.edu', name: 'Someone Else' })).name, 'Jane Doe', 'a name they set is kept');
    await assert.rejects(auth.sharepointLogin({ email: 'x@gmail.com' }), { code: 'DOMAIN' });
    await assert.rejects(auth.sharepointLogin({ email: 'not an email' }), { code: 'BAD_EMAIL' });
    assert.equal(await auth.passwordLogin('jane.doe@uthscsa.edu', 'anything'), null, 'no password sign-in for SharePoint accounts');
  });

  test(`${backend.name}: ADMIN_USERNAME is created as an admin at startup, and its password follows the setting`, async () => {
    const { store, auth } = await setup({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'first-password' });
    const log = [];
    await auth.bootstrap((m) => log.push(m));
    assert.equal((await store.getUser('admin')).isAdmin, true);
    assert.ok(await auth.passwordLogin('admin', 'first-password'));
    await auth.bootstrap((m) => log.push(m));
    assert.equal(log.length, 1, 'nothing to do the second time');
    await createAuth(store, { ...CFG, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'second-password' }).bootstrap((m) => log.push(m));
    assert.match(log[1], /password updated/);
    assert.equal(await auth.passwordLogin('admin', 'first-password'), null);
  });

  test(`${backend.name}: ADMIN_USERS makes the people it names admins when they sign in`, async () => {
    const { auth } = await setup({ ADMIN_USERS: ['lead', 'boss@uthscsa.edu'], SHAREPOINT_SIGNIN: true });
    await auth.setPassword('lead', 'longenough');
    assert.equal((await auth.passwordLogin('lead', 'longenough')).isAdmin, true);
    assert.equal((await auth.sharepointLogin({ email: 'boss@uthscsa.edu' })).isAdmin, true);
    assert.equal((await auth.sharepointLogin({ email: 'staff@uthscsa.edu' })).isAdmin, false);
  });
}
