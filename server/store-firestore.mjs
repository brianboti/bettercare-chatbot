// The same store as store.mjs, kept in Google Cloud Firestore (DATABASE=firestore).
//
// Collections (each name gets FIRESTORE_COLLECTION_PREFIX in front):
//   users/{userId}           profile, isAdmin, demo
//   turns/{id}               one question and its answer
//   events/{auto}            usage events for the dashboard
//   llmCalls/{auto}          one AI call and what it cost
//   promotions/{id}          content Clinical IT pushes
//   credentials/{userId}     password hash (never sent to a browser)
//   sessions/{tokenHash}     who a sign-in token belongs to, until when
//
// Every query is a single equality or a single range on one field, which
// Firestore indexes on its own: no composite indexes to deploy. Sorting and
// the dashboard's counting happen here and in insights.mjs.
//
// Turn and promotion ids are numbers, as in SQLite (the clients send them
// back as integers): the time in microseconds plus a random part, created
// with create() so a collision is retried rather than overwritten.
//
// Reads cost money in Firestore, so a few things are remembered briefly on
// this server: users and sessions (auth.mjs reads them on every request),
// and each person's turns for the personal welcome. Writes from this server
// clear what they change; another server's writes show up within seconds.

import { Firestore } from '@google-cloud/firestore';
import { randomInt } from 'node:crypto';
import { costOfResponse } from './pricing.mjs';
import { computeInsights, topicCounts, groupPeerQuestions, groupConversations, activePromotions } from './insights.mjs';

const now = () => new Date().toISOString();
const since = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const j = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const ALREADY_EXISTS = 6;
const BATCH = 400;

/** Remembers values for `ms`. */
function ttlCache(ms) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < ms) return e.v; m.delete(k); return undefined; },
    set(k, v) { m.set(k, { v, at: Date.now() }); return v; },
    delete(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

/**
 * @param {{ projectId?: string, databaseId?: string, prefix?: string, firestore?: Firestore }} opts
 *   `firestore` lets tests pass their own client (the emulator).
 */
export function openFirestoreStore({ projectId = '', databaseId = '(default)', prefix = '', firestore } = {}) {
  const db = firestore || new Firestore({
    ...(projectId ? { projectId } : {}),
    databaseId,
    ignoreUndefinedProperties: true,
    // HTTP instead of gRPC: a faster cold start, and enough for this traffic.
    // (Not with the emulator: the client only skips Google credentials for it over gRPC.)
    preferRest: !process.env.FIRESTORE_EMULATOR_HOST,
  });
  const col = (name) => db.collection(`${prefix}${name}`);
  const USERS = col('users'), TURNS = col('turns'), EVENTS = col('events'), CALLS = col('llmCalls');
  const PROMOS = col('promotions'), CREDS = col('credentials'), SESSIONS = col('sessions');

  const userCache = ttlCache(15_000);
  const sessionCache = ttlCache(15_000);
  const turnCache = ttlCache(10_000);
  const touched = new Map();      // userId -> when this server last wrote lastSeenAt

  async function inBatches(refs, apply) {
    for (let i = 0; i < refs.length; i += BATCH) {
      const b = db.batch();
      for (const r of refs.slice(i, i + BATCH)) apply(b, r);
      await b.commit();
    }
  }

  /**
   * A new numeric id, unique in `collection`; `make(id)` is the document.
   * Ids from this server only go up, so "ORDER BY id" is the order written.
   */
  let lastId = 0;
  async function createWithId(collection, make) {
    for (let attempt = 0; ; attempt++) {
      const id = lastId = Math.max(Date.now() * 1000 + randomInt(1000), lastId + 1);
      try {
        await collection.doc(String(id)).create(make(id));
        return id;
      } catch (e) {
        if (e.code !== ALREADY_EXISTS || attempt > 5) throw e;
      }
    }
  }

  // -------------------------------------------------------------- users

  const userOf = (id, d) => d && ({
    id, name: d.name ?? null, email: d.email ?? null, role: d.role ?? null, department: d.department ?? null,
    isAdmin: !!d.isAdmin, demo: !!d.demo, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null,
  });

  async function getUser(id) {
    if (!id) return null;
    const hit = userCache.get(id);
    if (hit !== undefined) return hit;
    const snap = await USERS.doc(id).get();
    return userCache.set(id, snap.exists ? userOf(id, snap.data()) : null);
  }

  /** Create or update a user; only the given fields change. */
  async function saveUser(id, fields = {}) {
    userCache.delete(id);
    const ref = USERS.doc(id);
    const snap = await ref.get();
    const cur = snap.exists ? userOf(id, snap.data()) : null;
    const u = { name: null, email: null, role: null, department: null, isAdmin: false, demo: false, ...cur, ...fields };
    const doc = { name: u.name, email: u.email, role: u.role, department: u.department, isAdmin: !!u.isAdmin, demo: !!u.demo };
    if (cur) await ref.update(doc);
    else await ref.set({ ...doc, createdAt: fields.createdAt || now(), lastSeenAt: null });
    userCache.delete(id);
    return getUser(id);
  }

  /** Record a visit. At most one write per person per 5 minutes from this server. */
  async function touchUser(id) {
    if (Date.now() - (touched.get(id) || 0) < 5 * 60_000) return;
    touched.set(id, Date.now());
    await USERS.doc(id).set({ lastSeenAt: now() }, { merge: true });
    userCache.delete(id);
  }

  async function listUsers({ demo } = {}) {
    const snap = await (demo ? USERS.where('demo', '==', true) : USERS).get();
    return snap.docs.map((d) => userOf(d.id, d.data())).sort((a, b) => ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0));
  }

  // -------------------------------------------------------------- turns

  const turnOf = (d) => d && ({
    id: d.id, userId: d.userId, conversationId: d.conversationId, at: d.at,
    question: d.question, rewritten: d.rewritten ?? null, intent: d.intent ?? null, topics: d.topics || [],
    answer: d.answer ?? null, sources: j(d.sources, []), suggestions: j(d.suggestions, null),
    confidence: d.confidence ?? null, lowConfidence: !!d.lowConfidence, mode: d.mode ?? null, latencyMs: d.latencyMs ?? null,
    error: d.error ?? null, feedback: d.feedback ?? null, feedbackNote: d.feedbackNote ?? null, assumptions: j(d.assumptions, []),
  });
  const visible = (d) => d.hiddenAt == null;

  /** Every turn (raw documents) of one person, oldest first. */
  async function userDocs(userId, { fresh = false } = {}) {
    const hit = !fresh && turnCache.get(userId);
    if (hit) return hit;
    const snap = await TURNS.where('userId', '==', userId).get();
    return turnCache.set(userId, snap.docs.map((d) => d.data()).sort((a, b) => a.id - b.id));
  }

  async function addTurn(t) {
    turnCache.delete(t.userId);
    const id = await createWithId(TURNS, (id) => ({
      id, userId: t.userId, conversationId: t.conversationId, at: t.at || now(), question: t.question,
      rewritten: t.rewritten ?? null, intent: t.intent ?? null, topics: t.topics || [], answer: t.answer ?? null,
      sources: JSON.stringify(t.sources || []), suggestions: t.suggestions ? JSON.stringify(t.suggestions) : null,
      confidence: t.confidence ?? null, lowConfidence: !!t.lowConfidence, mode: t.mode ?? null, latencyMs: t.latencyMs ?? null,
      error: t.error ?? null, feedback: null, feedbackNote: null, demo: !!t.demo,
      assumptions: t.assumptions?.length ? JSON.stringify(t.assumptions) : null, hiddenAt: null,
    }));
    turnCache.delete(t.userId);
    return id;
  }

  async function getTurn(id) {
    const snap = await TURNS.doc(String(id)).get();
    return snap.exists ? turnOf(snap.data()) : undefined;
  }

  /** A user's recent turns, newest first. */
  async function recentTurns(userId, limit = 5) {
    return (await userDocs(userId))
      .filter((d) => d.error == null && visible(d))
      .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : b.id - a.id))
      .slice(0, limit).map(turnOf);
  }

  /** Conversations for the history panel, newest first. */
  async function conversations(userId, limit = 50) {
    return groupConversations((await userDocs(userId, { fresh: true })).filter(visible), limit);
  }

  async function conversation(userId, conversationId) {
    const snap = await TURNS.where('conversationId', '==', conversationId).get();
    return snap.docs.map((d) => d.data()).filter((d) => d.userId === userId && visible(d)).sort((a, b) => a.id - b.id).map(turnOf);
  }

  /** Remove one conversation (or, with no id, every one) from a person's history. Returns how many questions. */
  async function hideHistory(userId, conversationId = null) {
    const docs = (await userDocs(userId, { fresh: true })).filter((d) => visible(d) && (!conversationId || d.conversationId === conversationId));
    const at = now();
    await inBatches(docs, (b, d) => b.update(TURNS.doc(String(d.id)), { hiddenAt: at }));
    turnCache.delete(userId);
    return docs.length;
  }

  /** How often a user asked about each topic lately, with when they last did. */
  async function userTopics(userId, days = 60) {
    const from = since(days);
    return topicCounts((await userDocs(userId))
      .filter((d) => d.at >= from && d.error == null && visible(d))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
  }

  /** What other people in the same role ask most, excluding topics this user already asked about. */
  async function peerQuestions(role, userId, { days = 45, limit = 5 } = {}) {
    if (!role) return [];
    const mine = new Set((await userTopics(userId, 365)).map((t) => t.topic));
    const peers = new Set((await USERS.where('role', '==', role).get()).docs.map((d) => d.id));
    peers.delete(userId);
    const rows = (await TURNS.where('at', '>=', since(days)).get()).docs.map((d) => d.data())
      .filter((t) => peers.has(t.userId) && t.error == null && !t.lowConfidence && visible(t) && (t.feedback == null || t.feedback > 0));
    return groupPeerQuestions(rows, mine, limit);
  }

  async function setFeedback(turnId, userId, value, note) {
    const ref = TURNS.doc(String(turnId));
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== userId) return false;
    await ref.update({ feedback: value, feedbackNote: note ?? null });
    turnCache.delete(userId);
    return true;
  }

  // -------------------------------------------------------------- events

  async function addEvent(e) {
    await EVENTS.add({
      userId: e.userId ?? null, at: e.at || now(), type: e.type, turnId: e.turnId ?? null, ref: e.ref ?? null,
      data: e.data ? JSON.stringify(e.data) : null, demo: !!e.demo,
    });
  }

  /** Promotion ids this user already clicked or dismissed. */
  async function promotionsActedOn(userId) {
    const snap = await EVENTS.where('userId', '==', userId).get();
    return new Set(snap.docs.map((d) => d.data()).filter((e) => e.type === 'promo_click' || e.type === 'promo_dismiss').map((e) => Number(e.ref)));
  }

  // -------------------------------------------------------------- Claude spend

  /** One Claude API call: { purpose, model, usage, userId? }. Cost is priced at write time. */
  async function addLlmCall(c) {
    const { cost, tokens } = costOfResponse(c.model, c.usage);
    await CALLS.add({
      at: c.at || now(), userId: c.userId ?? null, purpose: c.purpose, model: c.model ?? null,
      inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
      costUsd: cost, demo: !!c.demo,
    });
  }

  // -------------------------------------------------------------- promotions

  const promoOf = (d) => d && ({
    id: d.id, title: d.title, blurb: d.blurb ?? null, prompt: d.prompt, url: d.url || null, roles: d.roles || [],
    starts: d.starts ?? null, ends: d.ends ?? null, priority: d.priority ?? 0, active: !!d.active, createdAt: d.createdAt, createdBy: d.createdBy ?? null,
  });

  async function listPromotions() {
    const snap = await PROMOS.get();
    return snap.docs.map((d) => promoOf(d.data()))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || b.id - a.id);
  }

  async function savePromotion(p, by) {
    const fields = {
      title: p.title, blurb: p.blurb ?? null, prompt: p.prompt, roles: p.roles || [], starts: p.starts || null, ends: p.ends || null,
      priority: p.priority ?? 0, active: p.active !== false, url: p.url || null,
    };
    if (p.id) {
      const ref = PROMOS.doc(String(p.id));
      const snap = await ref.get();
      if (!snap.exists) return undefined;
      await ref.update(fields);
      return promoOf((await ref.get()).data());
    }
    const id = await createWithId(PROMOS, (id) => ({ id, ...fields, createdAt: now(), createdBy: by ?? null, demo: !!p.demo }));
    return promoOf((await PROMOS.doc(String(id)).get()).data());
  }

  /** Active, in-date promotions aimed at this role (or everyone), best first. */
  const promotionsFor = async (role, day = now().slice(0, 10)) => activePromotions(await listPromotions(), role, day);

  // -------------------------------------------------------------- sign-in

  async function getPasswordHash(userId) {
    const snap = await CREDS.doc(userId).get();
    return snap.exists ? snap.data().passwordHash : null;
  }
  async function setPasswordHash(userId, hash) {
    await CREDS.doc(userId).set({ passwordHash: hash, updatedAt: now() });
  }

  async function addSession(s) {
    await SESSIONS.doc(s.tokenHash).set({ userId: s.userId, method: s.method, createdAt: s.createdAt, expiresAt: s.expiresAt });
  }
  async function getSession(tokenHash) {
    const hit = sessionCache.get(tokenHash);
    if (hit !== undefined) return hit;
    const snap = await SESSIONS.doc(tokenHash).get();
    return sessionCache.set(tokenHash, snap.exists ? { tokenHash, ...snap.data() } : null);
  }
  async function deleteSession(tokenHash) {
    sessionCache.delete(tokenHash);
    await SESSIONS.doc(tokenHash).delete();
  }
  /** Sign someone out everywhere (after a password change). */
  async function deleteUserSessions(userId) {
    const snap = await SESSIONS.where('userId', '==', userId).get();
    await inBatches(snap.docs, (b, d) => b.delete(d.ref));
    sessionCache.clear();
    return snap.size;
  }

  // -------------------------------------------------------------- admin

  /** Everything the insights dashboard shows, for the last `days` days. */
  async function insights({ days = 30, role = null } = {}) {
    const from = since(days);
    const [userSnap, turnSnap, eventSnap, callSnap, promotions, firstCall, demoSnap] = await Promise.all([
      USERS.get(), TURNS.where('at', '>=', from).get(), EVENTS.where('at', '>=', from).get(), CALLS.where('at', '>=', from).get(),
      listPromotions(), CALLS.orderBy('at').limit(1).get(), TURNS.where('demo', '==', true).limit(1).get(),
    ]);
    const roleOf = new Map(userSnap.docs.map((d) => [d.id, d.data().role ?? null]));
    const withRole = (x) => ({ ...x, role: x.userId != null ? roleOf.get(x.userId) ?? null : null });
    const inRole = (x) => !role || x.role === role;
    const turns = turnSnap.docs.map((d) => d.data())
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
      .map((d) => withRole({ ...turnOf(d), userId: d.userId })).filter(inRole);
    const events = eventSnap.docs.map((d) => d.data())
      .map((e) => withRole({ userId: e.userId, type: e.type, turnId: e.turnId, ref: e.ref, data: j(e.data, null) })).filter(inRole);
    const calls = callSnap.docs.map((d) => withRole(d.data())).filter(inRole);
    return computeInsights({
      days, role, turns, events, calls, promotions,
      spendSince: firstCall.docs[0]?.data().at || null,
      demoData: !demoSnap.empty,
    });
  }

  /** Remove every demo row (people, their sign-ins, history, events, spend, promotions). */
  async function clearDemo() {
    const demoUsers = (await USERS.where('demo', '==', true).get()).docs.map((d) => d.id);
    for (const id of demoUsers) {
      await CREDS.doc(id).delete();
      await deleteUserSessions(id);
    }
    for (const c of [TURNS, EVENTS, PROMOS, CALLS, USERS]) {
      const snap = await c.where('demo', '==', true).get();
      await inBatches(snap.docs, (b, d) => b.delete(d.ref));
    }
    userCache.clear(); turnCache.clear();
  }

  return {
    kind: 'firestore', firestore: db, getUser, saveUser, touchUser, listUsers,
    addTurn, getTurn, recentTurns, conversations, conversation, hideHistory, userTopics, peerQuestions, setFeedback,
    addEvent, addLlmCall, promotionsActedOn, listPromotions, savePromotion, promotionsFor, insights, clearDemo,
    getPasswordHash, setPasswordHash, addSession, getSession, deleteSession, deleteUserSessions,
    close: () => (firestore ? Promise.resolve() : db.terminate()),
  };
}
