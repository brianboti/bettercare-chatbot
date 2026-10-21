// Per-user state: profiles, question history, feedback, usage events, Claude
// spend, the content the org wants to push, and sign-in (passwords and
// sessions). SQLite (node:sqlite, built into Node), one file at data/sophia.db.
//
// This is one of two databases behind the same methods; store-firestore.mjs
// is the other, and db.mjs picks one from DATABASE. Callers always `await`
// the methods: here they return straight away, in Firestore they don't.
// Rows written by tools/seed-demo.mjs carry demo=1 so they can be told apart
// and removed.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { costOfResponse } from './pricing.mjs';
import { computeInsights, topicCounts, groupPeerQuestions, groupConversations, activePromotions, normalizeQuestion } from './insights.mjs';

export { normalizeQuestion };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  role TEXT,
  department TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  at TEXT NOT NULL,
  question TEXT NOT NULL,
  rewritten TEXT,
  intent TEXT,
  topics TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  suggestions TEXT,
  confidence REAL,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  mode TEXT,
  latency_ms INTEGER,
  error TEXT,
  feedback INTEGER,
  feedback_note TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_user ON turns(user_id, at);
CREATE INDEX IF NOT EXISTS turns_conv ON turns(conversation_id, id);
CREATE INDEX IF NOT EXISTS turns_at ON turns(at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  turn_id INTEGER,
  ref TEXT,
  data TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_type ON events(type, at);
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  blurb TEXT,
  prompt TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  starts TEXT,
  ends TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  url TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  purpose TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls(at);
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

const j = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const now = () => new Date().toISOString();
const since = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

/** The SQLite store. `file` is a path or ':memory:'. */
export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after a database was first created.
  const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!hasColumn('promotions', 'url')) db.exec('ALTER TABLE promotions ADD COLUMN url TEXT');
  if (!hasColumn('turns', 'assumptions')) db.exec('ALTER TABLE turns ADD COLUMN assumptions TEXT');
  // Set when the person removes the question from their history. The row stays
  // for the admin usage counts; it's gone from everything the person sees and
  // from suggestions to others.
  if (!hasColumn('turns', 'hidden_at')) db.exec('ALTER TABLE turns ADD COLUMN hidden_at TEXT');

  const q = (sql) => db.prepare(sql);

  // -------------------------------------------------------------- users

  const userRow = (r) => r && ({
    id: r.id, name: r.name, email: r.email, role: r.role, department: r.department,
    isAdmin: !!r.is_admin, demo: !!r.demo, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
  });

  function getUser(id) {
    return (id && userRow(q('SELECT * FROM users WHERE id = ?').get(id))) || null;
  }

  /** Create or update a user; only the given fields change. */
  function saveUser(id, fields = {}) {
    const cur = getUser(id);
    const u = { name: null, email: null, role: null, department: null, isAdmin: false, demo: false, ...cur, ...fields };
    if (cur) {
      q('UPDATE users SET name=?, email=?, role=?, department=?, is_admin=?, demo=? WHERE id=?')
        .run(u.name, u.email, u.role, u.department, u.isAdmin ? 1 : 0, u.demo ? 1 : 0, id);
    } else {
      q('INSERT INTO users (id, name, email, role, department, is_admin, demo, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, u.name, u.email, u.role, u.department, u.isAdmin ? 1 : 0, u.demo ? 1 : 0, fields.createdAt || now());
    }
    return getUser(id);
  }

  const touchUser = (id) => q('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), id);

  const listUsers = ({ demo } = {}) => q(`SELECT * FROM users ${demo ? 'WHERE demo = 1' : ''} ORDER BY name`).all().map(userRow);

  // -------------------------------------------------------------- turns

  const turnRow = (r) => r && ({
    id: r.id, userId: r.user_id, conversationId: r.conversation_id, at: r.at,
    question: r.question, rewritten: r.rewritten, intent: r.intent, topics: j(r.topics, []),
    answer: r.answer, sources: j(r.sources, []), suggestions: j(r.suggestions, null),
    confidence: r.confidence, lowConfidence: !!r.low_confidence, mode: r.mode, latencyMs: r.latency_ms,
    error: r.error, feedback: r.feedback, feedbackNote: r.feedback_note, assumptions: j(r.assumptions, []),
  });

  function addTurn(t) {
    const r = q(`INSERT INTO turns (user_id, conversation_id, at, question, rewritten, intent, topics, answer, sources,
      suggestions, confidence, low_confidence, mode, latency_ms, error, demo, assumptions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.userId, t.conversationId, t.at || now(), t.question, t.rewritten ?? null, t.intent ?? null,
        JSON.stringify(t.topics || []), t.answer ?? null, JSON.stringify(t.sources || []),
        t.suggestions ? JSON.stringify(t.suggestions) : null, t.confidence ?? null, t.lowConfidence ? 1 : 0,
        t.mode ?? null, t.latencyMs ?? null, t.error ?? null, t.demo ? 1 : 0,
        t.assumptions?.length ? JSON.stringify(t.assumptions) : null);
    return Number(r.lastInsertRowid);
  }

  const getTurn = (id) => turnRow(q('SELECT * FROM turns WHERE id = ?').get(id));

  /** A user's recent turns, newest first. */
  const recentTurns = (userId, limit = 5) =>
    q('SELECT * FROM turns WHERE user_id = ? AND error IS NULL AND hidden_at IS NULL ORDER BY at DESC, id DESC LIMIT ?').all(userId, limit).map(turnRow);

  /** Conversations for the history panel, newest first. */
  const conversations = (userId, limit = 50) =>
    groupConversations(q('SELECT id, conversation_id, at, question FROM turns WHERE user_id = ? AND hidden_at IS NULL').all(userId)
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, at: r.at, question: r.question })), limit);

  const conversation = (userId, conversationId) =>
    q('SELECT * FROM turns WHERE user_id = ? AND conversation_id = ? AND hidden_at IS NULL ORDER BY id').all(userId, conversationId).map(turnRow);

  /** Remove one conversation (or, with no id, every one) from a person's history. Returns how many questions. */
  function hideHistory(userId, conversationId = null) {
    const r = conversationId
      ? q('UPDATE turns SET hidden_at = ? WHERE user_id = ? AND conversation_id = ? AND hidden_at IS NULL').run(now(), userId, conversationId)
      : q('UPDATE turns SET hidden_at = ? WHERE user_id = ? AND hidden_at IS NULL').run(now(), userId);
    return Number(r.changes);
  }

  /** How often a user asked about each topic lately, with when they last did. */
  const userTopics = (userId, days = 60) =>
    topicCounts(q('SELECT topics, at FROM turns WHERE user_id = ? AND at >= ? AND error IS NULL AND hidden_at IS NULL ORDER BY at').all(userId, since(days))
      .map((t) => ({ at: t.at, topics: j(t.topics, []) })));

  /**
   * What other people in the same role ask most, excluding topics this user
   * already asked about. "The same question" = same normalized text.
   */
  function peerQuestions(role, userId, { days = 45, limit = 5 } = {}) {
    if (!role) return [];
    const mine = new Set(userTopics(userId, 365).map((t) => t.topic));
    const rows = q(`SELECT t.question, t.topics, t.user_id FROM turns t JOIN users u ON u.id = t.user_id
      WHERE u.role = ? AND t.user_id != ? AND t.at >= ? AND t.error IS NULL AND t.low_confidence = 0 AND t.hidden_at IS NULL
        AND (t.feedback IS NULL OR t.feedback > 0)`).all(role, userId, since(days));
    return groupPeerQuestions(rows.map((r) => ({ question: r.question, topics: j(r.topics, []), userId: r.user_id })), mine, limit);
  }

  function setFeedback(turnId, userId, value, note) {
    const r = q('UPDATE turns SET feedback = ?, feedback_note = ? WHERE id = ? AND user_id = ?').run(value, note ?? null, turnId, userId);
    return r.changes > 0;
  }

  // -------------------------------------------------------------- events

  function addEvent(e) {
    q('INSERT INTO events (user_id, at, type, turn_id, ref, data, demo) VALUES (?,?,?,?,?,?,?)')
      .run(e.userId ?? null, e.at || now(), e.type, e.turnId ?? null, e.ref ?? null, e.data ? JSON.stringify(e.data) : null, e.demo ? 1 : 0);
  }

  /** Promotion ids this user already clicked or dismissed. */
  const promotionsActedOn = (userId) => new Set(q(`SELECT DISTINCT ref FROM events WHERE user_id = ? AND type IN ('promo_click','promo_dismiss')`)
    .all(userId).map((r) => Number(r.ref)));

  // -------------------------------------------------------------- Claude spend

  /** One Claude API call: { purpose, model, usage, userId? }. Cost is priced at write time. */
  function addLlmCall(c) {
    const { cost, tokens } = costOfResponse(c.model, c.usage);
    q(`INSERT INTO llm_calls (at, user_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, demo)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(c.at || now(), c.userId ?? null, c.purpose, c.model ?? null, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, cost, c.demo ? 1 : 0);
  }

  // -------------------------------------------------------------- promotions

  const promoRow = (r) => r && ({
    id: r.id, title: r.title, blurb: r.blurb, prompt: r.prompt, url: r.url || null, roles: j(r.roles, []),
    starts: r.starts, ends: r.ends, priority: r.priority, active: !!r.active, createdAt: r.created_at, createdBy: r.created_by,
  });

  const listPromotions = () => q('SELECT * FROM promotions ORDER BY active DESC, priority DESC, id DESC').all().map(promoRow);

  function savePromotion(p, by) {
    const vals = [p.title, p.blurb ?? null, p.prompt, JSON.stringify(p.roles || []), p.starts || null, p.ends || null, p.priority ?? 0, p.active === false ? 0 : 1, p.url || null];
    if (p.id) {
      q('UPDATE promotions SET title=?, blurb=?, prompt=?, roles=?, starts=?, ends=?, priority=?, active=?, url=? WHERE id=?').run(...vals, p.id);
      return promoRow(q('SELECT * FROM promotions WHERE id = ?').get(p.id));
    }
    const r = q('INSERT INTO promotions (title, blurb, prompt, roles, starts, ends, priority, active, url, created_at, created_by, demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...vals, now(), by ?? null, p.demo ? 1 : 0);
    return promoRow(q('SELECT * FROM promotions WHERE id = ?').get(r.lastInsertRowid));
  }

  /** Active, in-date promotions aimed at this role (or everyone), best first. */
  const promotionsFor = (role, day = now().slice(0, 10)) => activePromotions(listPromotions(), role, day);

  // -------------------------------------------------------------- sign-in

  const getPasswordHash = (userId) => q('SELECT password_hash FROM credentials WHERE user_id = ?').get(userId)?.password_hash || null;
  const setPasswordHash = (userId, hash) => {
    q('INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at').run(userId, hash, now());
  };

  /** s = { tokenHash, userId, method, createdAt, expiresAt } */
  const addSession = (s) => {
    q('INSERT INTO sessions (token_hash, user_id, method, created_at, expires_at) VALUES (?,?,?,?,?)').run(s.tokenHash, s.userId, s.method, s.createdAt, s.expiresAt);
  };
  const getSession = (tokenHash) => {
    const r = q('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    return r ? { tokenHash: r.token_hash, userId: r.user_id, method: r.method, createdAt: r.created_at, expiresAt: r.expires_at } : null;
  };
  const deleteSession = (tokenHash) => { q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); };
  /** Sign someone out everywhere (after a password change). */
  const deleteUserSessions = (userId) => Number(q('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);

  // -------------------------------------------------------------- admin

  /** Everything the insights dashboard shows, for the last `days` days. */
  function insights({ days = 30, role = null } = {}) {
    const from = since(days);
    const roleSql = role ? 'AND u.role = ?' : '';
    const args = role ? [from, role] : [from];
    const turns = q(`SELECT t.*, u.role FROM turns t LEFT JOIN users u ON u.id = t.user_id WHERE t.at >= ? ${roleSql} ORDER BY t.at`).all(...args)
      .map((r) => ({ ...turnRow(r), role: r.role }));
    const events = q(`SELECT e.*, u.role FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.at >= ? ${roleSql}`).all(...args)
      .map((e) => ({ type: e.type, turnId: e.turn_id, ref: e.ref, data: j(e.data, null), role: e.role }));
    const calls = q(`SELECT c.*, u.role FROM llm_calls c LEFT JOIN users u ON u.id = c.user_id WHERE c.at >= ? ${roleSql}`).all(...args)
      .map((c) => ({ at: c.at, purpose: c.purpose, model: c.model, inputTokens: c.input_tokens, outputTokens: c.output_tokens, cacheReadTokens: c.cache_read_tokens, cacheWriteTokens: c.cache_write_tokens, costUsd: c.cost_usd }));
    return computeInsights({
      days, role, turns, events, calls,
      promotions: listPromotions(),
      spendSince: q('SELECT MIN(at) AS at FROM llm_calls').get()?.at || null,
      demoData: !!q('SELECT 1 FROM turns WHERE demo = 1 LIMIT 1').get(),
    });
  }

  function clearDemo() {
    db.exec('DELETE FROM credentials WHERE user_id IN (SELECT id FROM users WHERE demo = 1)');
    db.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE demo = 1)');
    for (const t of ['turns', 'events', 'promotions', 'llm_calls', 'users']) db.exec(`DELETE FROM ${t} WHERE demo = 1`);
  }

  return {
    kind: 'sqlite', db, getUser, saveUser, touchUser, listUsers,
    addTurn, getTurn, recentTurns, conversations, conversation, hideHistory, userTopics, peerQuestions, setFeedback,
    addEvent, addLlmCall, promotionsActedOn, listPromotions, savePromotion, promotionsFor, insights, clearDemo,
    getPasswordHash, setPasswordHash, addSession, getSession, deleteSession, deleteUserSessions,
    close: () => db.close(),
  };
}
