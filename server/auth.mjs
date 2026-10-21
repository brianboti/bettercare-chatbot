// Who is asking, and how they signed in.
//
// Every way of signing in ends the same way: a session. The server makes a
// random token, keeps only its SHA-256 in the database (sessions), and hands
// the token to the browser:
//   - the website gets it as an HttpOnly cookie (sophia_session), so page
//     scripts never see it
//   - the extension gets it in the response and sends it back as
//     "Authorization: Bearer <token>" (it is on another origin, so it can't
//     use the site's cookie)
//
// Sign-in methods today (AUTH_MODE=password):
//   password    username + password stored in the database (scrypt hash).
//               Accounts come from ADMIN_USERNAME, `npm run users`, or the
//               sign-in page when ALLOW_SIGNUP=1.
//   sharepoint  the extension reads who is signed in to SharePoint and sends
//               it here (SHAREPOINT_SIGNIN=1). The server cannot check that
//               claim, so this is for demos only.
//
// Microsoft sign-in (Entra ID) adds one more method and nothing else changes:
// a /api/auth/microsoft route that redirects to Microsoft, a callback that
// validates the ID token (issuer, audience, signature) and calls
// startSession(email, 'microsoft'). Users, history and the admin flag stay
// keyed by the same user id, so set up the Microsoft user ids to match (the
// work email, lowercased).
//
// AUTH_MODE=header skips all of this and trusts the X-Sophia-User header.
// It exists for local development and the tests.

import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config as defaultConfig } from './config.mjs';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'sophia_session';
/** User ids: what the X-Sophia-User header and the database accept. */
export const USER_ID = /^[a-z0-9._@-]{1,120}$/;
/** Usernames for password accounts. No "@": email ids belong to SharePoint and Microsoft sign-in. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const MIN_PASSWORD = 8;

export class AuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------- passwords

const N = 16384, R = 8, P = 1, KEYLEN = 32;

/** "scrypt$N$r$p$salt$hash", salt and hash in base64. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

// A hash to check against when the username doesn't exist, so a wrong
// username takes as long as a wrong password.
const DUMMY = hashPassword(randomBytes(12).toString('hex'));

// ---------------------------------------------------------------- tokens and cookies

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/** Cookie value from a Cookie header. */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The session token a request carries: Authorization: Bearer, else the cookie. */
export function requestToken(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization || '').trim());
  if (m) return m[1];
  const c = readCookie(req.headers.cookie, SESSION_COOKIE);
  return c && /^[A-Za-z0-9_-]{20,200}$/.test(c) ? c : null;
}

// ---------------------------------------------------------------- the auth object

/**
 * @param {object} store  the database (store.mjs or store-firestore.mjs)
 * @param {object} [cfg]  settings (config.mjs); tests pass their own
 */
export function createAuth(store, cfg = defaultConfig) {
  const sessionMs = cfg.SESSION_DAYS * 86_400_000;
  const adminList = new Set(cfg.ADMIN_USERS || []);

  /** What the sign-in page and the extension need to know. */
  const publicConfig = () => ({
    mode: cfg.AUTH_MODE,
    methods: cfg.AUTH_MODE === 'header' ? [] : ['password', ...(cfg.SHAREPOINT_SIGNIN ? ['sharepoint'] : [])],
    signup: cfg.AUTH_MODE !== 'header' && cfg.ALLOW_SIGNUP,
  });

  /** Make someone an admin if ADMIN_USERS names them. */
  async function withAdminList(user) {
    if (!user || user.isAdmin) return user;
    if (adminList.has(user.id) || (user.email && adminList.has(user.email.toLowerCase()))) return store.saveUser(user.id, { isAdmin: true });
    return user;
  }

  /**
   * Who is asking: { id, user, via }. `id` without a `user` is an id the
   * database doesn't know yet (header mode only). Nobody: { id: null, user: null }.
   */
  async function identify(req) {
    if (cfg.AUTH_MODE === 'header') {
      const id = String(req.headers['x-sophia-user'] || '').trim().toLowerCase().slice(0, 120);
      if (!USER_ID.test(id)) return { id: null, user: null, via: null };
      return { id, user: await store.getUser(id), via: 'header' };
    }
    const token = requestToken(req);
    if (!token) return { id: null, user: null, via: null };
    const s = await store.getSession(tokenHash(token));
    if (!s) return { id: null, user: null, via: null };
    if (s.expiresAt <= new Date().toISOString()) {
      await store.deleteSession(s.tokenHash);
      return { id: null, user: null, via: null };
    }
    return { id: s.userId, user: await store.getUser(s.userId), via: s.method };
  }

  /** A new session for this person: { token, expiresAt }. */
  async function startSession(userId, method) {
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionMs).toISOString();
    await store.addSession({ tokenHash: tokenHash(token), userId, method, createdAt, expiresAt });
    return { token, expiresAt };
  }

  async function endSession(req) {
    const token = requestToken(req);
    if (token) await store.deleteSession(tokenHash(token));
  }

  /** The user for a correct username and password, else null. */
  async function passwordLogin(username, password) {
    const id = String(username || '').trim().toLowerCase();
    const stored = USERNAME.test(id) ? await store.getPasswordHash(id) : null;
    const ok = await verifyPassword(String(password || ''), stored || await DUMMY);
    if (!ok || !stored) return null;
    const user = (await store.getUser(id)) || (await store.saveUser(id, {}));
    return withAdminList(user);
  }

  /** Create or replace a password account. Returns the user. */
  async function setPassword(username, password, fields = {}) {
    const id = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(id)) throw new AuthError('BAD_USERNAME', 'Usernames are 2–64 lowercase letters, digits, dots, dashes or underscores, with no "@".');
    if (String(password || '').length < MIN_PASSWORD) throw new AuthError('WEAK_PASSWORD', `Passwords need at least ${MIN_PASSWORD} characters.`);
    const user = await store.saveUser(id, fields);
    await store.setPasswordHash(id, await hashPassword(password));
    return user;
  }

  /** The sign-in page's "Create account" (ALLOW_SIGNUP=1). */
  async function signup(username, password, name) {
    if (!publicConfig().signup) throw new AuthError('SIGNUP_CLOSED', 'Ask an administrator for an account.', 403);
    const id = String(username || '').trim().toLowerCase();
    if (USERNAME.test(id) && (await store.getPasswordHash(id) || await store.getUser(id))) throw new AuthError('TAKEN', 'That username is taken.', 409);
    const user = await setPassword(id, password, typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 80) } : {});
    return withAdminList(user);
  }

  /**
   * The extension's SharePoint sign-in: { email, name } as SharePoint reported
   * them. Not verifiable here; only on when SHAREPOINT_SIGNIN=1.
   */
  async function sharepointLogin({ email, name } = {}) {
    if (!publicConfig().methods.includes('sharepoint')) throw new AuthError('METHOD_OFF', 'SharePoint sign-in is turned off on this server.', 403);
    const id = String(email || '').trim().toLowerCase();
    const domain = id.split('@')[1] || '';
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(id) || id.length > 120) throw new AuthError('BAD_EMAIL', 'SharePoint did not give a usable email address.');
    if (cfg.SHAREPOINT_EMAIL_DOMAINS.length && !cfg.SHAREPOINT_EMAIL_DOMAINS.includes(domain)) throw new AuthError('DOMAIN', `Accounts from ${domain} can't sign in here.`, 403);
    const cur = await store.getUser(id);
    const fields = { email: id };
    if (!cur?.name && typeof name === 'string' && name.trim()) fields.name = name.trim().slice(0, 80);
    return withAdminList(await store.saveUser(id, fields));
  }

  /** ADMIN_USERNAME / ADMIN_PASSWORD: make sure that admin exists with that password. */
  async function bootstrap(log = () => {}) {
    if (cfg.AUTH_MODE === 'header' || !cfg.ADMIN_USERNAME || !cfg.ADMIN_PASSWORD) return;
    const stored = await store.getPasswordHash(cfg.ADMIN_USERNAME);
    if (!stored || !(await verifyPassword(cfg.ADMIN_PASSWORD, stored))) {
      await setPassword(cfg.ADMIN_USERNAME, cfg.ADMIN_PASSWORD, { isAdmin: true, name: (await store.getUser(cfg.ADMIN_USERNAME))?.name || 'Administrator' });
      log(`  admin account ${cfg.ADMIN_USERNAME} ${stored ? 'password updated' : 'created'}`);
    } else if (!(await store.getUser(cfg.ADMIN_USERNAME))?.isAdmin) {
      await store.saveUser(cfg.ADMIN_USERNAME, { isAdmin: true });
    }
  }

  /** Set-Cookie for a new session, or (no token) one that clears it. */
  function cookie(token, { secure = false, expiresAt = null } = {}) {
    const parts = [`${SESSION_COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (token) parts.push(`Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}`);
    else parts.push('Max-Age=0');
    if (secure || cfg.COOKIE_SECURE) parts.push('Secure');
    return parts.join('; ');
  }

  return { publicConfig, identify, startSession, endSession, passwordLogin, setPassword, signup, sharepointLogin, bootstrap, cookie, withAdminList };
}
