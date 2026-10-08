// Per-user state: profiles, question history, feedback, usage events, and the
// content the org wants to push. SQLite (node:sqlite, built into Node), one
// file at data/sophia.db.
//
// Everything here is synchronous and small; the chat path does one insert
// per turn. Rows written by tools/seed-demo.mjs carry demo=1 so they can be
// told apart and removed.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
`;

const j = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const now = () => new Date().toISOString();
const since = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Lowercased, punctuation-free form, for counting "the same question". */
export const normalizeQuestion = (q) => String(q).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after a database was first created.
  const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!hasColumn('promotions', 'url')) db.exec('ALTER TABLE promotions ADD COLUMN url TEXT');

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
    error: r.error, feedback: r.feedback, feedbackNote: r.feedback_note,
  });

  function addTurn(t) {
    const r = q(`INSERT INTO turns (user_id, conversation_id, at, question, rewritten, intent, topics, answer, sources,
      suggestions, confidence, low_confidence, mode, latency_ms, error, demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.userId, t.conversationId, t.at || now(), t.question, t.rewritten ?? null, t.intent ?? null,
        JSON.stringify(t.topics || []), t.answer ?? null, JSON.stringify(t.sources || []),
        t.suggestions ? JSON.stringify(t.suggestions) : null, t.confidence ?? null, t.lowConfidence ? 1 : 0,
        t.mode ?? null, t.latencyMs ?? null, t.error ?? null, t.demo ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  const getTurn = (id) => turnRow(q('SELECT * FROM turns WHERE id = ?').get(id));

  /** A user's recent turns, newest first. */
  const recentTurns = (userId, limit = 5) =>
    q('SELECT * FROM turns WHERE user_id = ? AND error IS NULL ORDER BY at DESC, id DESC LIMIT ?').all(userId, limit).map(turnRow);

  /** Conversations for the history panel, newest first. */
  function conversations(userId, limit = 50) {
    return q(`SELECT conversation_id, MIN(at) AS started, MAX(at) AS last, COUNT(*) AS n,
        (SELECT question FROM turns t2 WHERE t2.conversation_id = t.conversation_id AND t2.user_id = t.user_id ORDER BY id LIMIT 1) AS first
      FROM turns t WHERE user_id = ? GROUP BY conversation_id ORDER BY last DESC LIMIT ?`)
      .all(userId, limit)
      .map((r) => ({ conversationId: r.conversation_id, startedAt: r.started, lastAt: r.last, turns: r.n, title: r.first }));
  }

  const conversation = (userId, conversationId) =>
    q('SELECT * FROM turns WHERE user_id = ? AND conversation_id = ? ORDER BY id').all(userId, conversationId).map(turnRow);

  /** How often a user asked about each topic lately, with when they last did. */
  function userTopics(userId, days = 60) {
    const counts = new Map();
    for (const t of q('SELECT topics, at FROM turns WHERE user_id = ? AND at >= ? AND error IS NULL ORDER BY at').all(userId, since(days))) {
      for (const name of j(t.topics, [])) {
        const c = counts.get(name) || { topic: name, count: 0, lastAt: null };
        c.count++; c.lastAt = t.at;
        counts.set(name, c);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  }

  /**
   * What other people in the same role ask most, excluding topics this user
   * already asked about. "The same question" = same normalized text.
   */
  function peerQuestions(role, userId, { days = 45, limit = 5 } = {}) {
    if (!role) return [];
    const mine = new Set(userTopics(userId, 365).map((t) => t.topic));
    const rows = q(`SELECT t.question, t.topics, t.user_id FROM turns t JOIN users u ON u.id = t.user_id
      WHERE u.role = ? AND t.user_id != ? AND t.at >= ? AND t.error IS NULL AND t.low_confidence = 0
        AND (t.feedback IS NULL OR t.feedback > 0)`).all(role, userId, since(days));
    const groups = new Map();
    for (const r of rows) {
      const topics = j(r.topics, []);
      if (topics.some((x) => mine.has(x))) continue;
      const key = normalizeQuestion(r.question);
      const g = groups.get(key) || { question: r.question, topics, people: new Set(), count: 0 };
      g.people.add(r.user_id); g.count++;
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort((a, b) => b.people.size - a.people.size || b.count - a.count)
      .slice(0, limit)
      .map((g) => ({ question: g.question, topics: g.topics, people: g.people.size }));
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
  function promotionsFor(role, day = now().slice(0, 10)) {
    return listPromotions().filter((p) => p.active
      && (!p.starts || p.starts <= day) && (!p.ends || p.ends >= day)
      && (!p.roles.length || p.roles.includes(role)));
  }

  // -------------------------------------------------------------- admin

  /** Everything the insights dashboard shows, for the last `days` days. */
  function insights({ days = 30, role = null } = {}) {
    const from = since(days);
    const roleSql = role ? 'AND u.role = ?' : '';
    const args = role ? [from, role] : [from];
    const turns = q(`SELECT t.*, u.role FROM turns t LEFT JOIN users u ON u.id = t.user_id WHERE t.at >= ? ${roleSql} ORDER BY t.at`).all(...args);
    const events = q(`SELECT e.*, u.role FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.at >= ? ${roleSql}`).all(...args);

    const byDay = new Map();
    const topicCount = new Map();
    const topicRole = new Map();
    const roleCount = new Map();
    const users = new Set();
    let up = 0, down = 0, low = 0, errors = 0;
    for (const t of turns) {
      const d = t.at.slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + 1);
      users.add(t.user_id);
      const r = t.role || 'unknown';
      roleCount.set(r, (roleCount.get(r) || 0) + 1);
      for (const tp of j(t.topics, [])) {
        topicCount.set(tp, (topicCount.get(tp) || 0) + 1);
        const k = `${tp}\u0000${r}`;
        topicRole.set(k, (topicRole.get(k) || 0) + 1);
      }
      if (t.feedback > 0) up++;
      if (t.feedback < 0) down++;
      if (t.low_confidence) low++;
      if (t.error) errors++;
    }

    // Questions asked again in other words: the same person, same
    // conversation, within 3 minutes, on a shared topic, without having
    // opened a source from the first answer.
    const clicked = new Set(events.filter((e) => e.type === 'citation_click').map((e) => e.turn_id));
    const rephrased = new Set();
    const byConv = new Map();
    for (const t of turns) (byConv.get(t.conversation_id) || byConv.set(t.conversation_id, []).get(t.conversation_id)).push(t);
    for (const list of byConv.values()) {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        const gap = Date.parse(b.at) - Date.parse(a.at);
        const shared = j(a.topics, []).some((x) => j(b.topics, []).includes(x));
        if (gap < 180_000 && shared && !clicked.has(a.id)) rephrased.add(a.id);
      }
    }

    const trouble = turns
      .filter((t) => t.low_confidence || t.feedback < 0 || t.error || rephrased.has(t.id))
      .reverse()
      .slice(0, 60)
      .map((t) => ({
        id: t.id, at: t.at, role: t.role, question: t.question, topics: j(t.topics, []), confidence: t.confidence,
        reasons: [t.low_confidence && 'weak match', t.feedback < 0 && 'thumbs down', t.error && 'error', rephrased.has(t.id) && 'asked again'].filter(Boolean),
        note: t.feedback_note,
      }));

    // Every rating, with what the person wrote, newest first.
    const feedback = turns
      .filter((t) => t.feedback)
      .reverse()
      .slice(0, 300)
      .map((t) => ({
        id: t.id, at: t.at, role: t.role, question: t.question, topics: j(t.topics, []),
        answer: t.answer ? t.answer.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').slice(0, 1200) : null,
        value: t.feedback, note: t.feedback_note,
      }));

    // Where people end up: sources opened from answers.
    const opened = new Map();
    for (const e of events.filter((x) => x.type === 'citation_click')) {
      const d = j(e.data, {});
      const key = d.title || e.ref;
      const o = opened.get(key) || { title: key, kind: d.kind, url: d.url, count: 0 };
      o.count++;
      opened.set(key, o);
    }

    // Top questions (same normalized text).
    const qs = new Map();
    for (const t of turns) {
      const k = normalizeQuestion(t.question);
      const g = qs.get(k) || { question: t.question, count: 0, roles: new Set(), topics: j(t.topics, []) };
      g.count++; g.roles.add(t.role || 'unknown');
      qs.set(k, g);
    }

    const promos = listPromotions().map((p) => {
      const ev = events.filter((e) => Number(e.ref) === p.id);
      return { ...p, shown: ev.filter((e) => e.type === 'promo_shown').length, clicked: ev.filter((e) => e.type === 'promo_click').length, linkOpens: ev.filter((e) => e.type === 'promo_link_click').length };
    });

    return {
      days, role,
      demoData: !!q('SELECT 1 FROM turns WHERE demo = 1 LIMIT 1').get(),
      totals: { questions: turns.length, users: users.size, up, down, comments: turns.filter((t) => t.feedback && t.feedback_note).length, lowConfidence: low, errors, rephrased: rephrased.size },
      byDay: [...byDay].map(([day, count]) => ({ day, count })),
      byRole: [...roleCount].map(([r, count]) => ({ role: r, count })).sort((a, b) => b.count - a.count),
      topics: [...topicCount].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count),
      topicRole: [...topicRole].map(([k, count]) => { const [topic, r] = k.split('\u0000'); return { topic, role: r, count }; }),
      // share = this question's part of every question asked in the period.
      topQuestions: [...qs.values()].sort((a, b) => b.count - a.count).slice(0, 15)
        .map((g) => ({ ...g, roles: [...g.roles], share: turns.length ? g.count / turns.length : 0 })),
      trouble,
      feedback,
      opened: [...opened.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      recent: turns.slice(-40).reverse().map((t) => ({ id: t.id, at: t.at, role: t.role, question: t.question, topics: j(t.topics, []), feedback: t.feedback, note: t.feedback_note, lowConfidence: !!t.low_confidence })),
      promotions: promos,
    };
  }

  function clearDemo() {
    for (const t of ['turns', 'events', 'promotions', 'users']) db.exec(`DELETE FROM ${t} WHERE demo = 1`);
  }

  return {
    db, getUser, saveUser, touchUser, listUsers,
    addTurn, getTurn, recentTurns, conversations, conversation, userTopics, peerQuestions, setFeedback,
    addEvent, promotionsActedOn, listPromotions, savePromotion, promotionsFor, insights, clearDemo,
    close: () => db.close(),
  };
}
