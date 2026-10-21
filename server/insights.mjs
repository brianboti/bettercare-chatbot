// The insights dashboard's numbers, worked out from plain rows. Both
// databases (store.mjs for SQLite, store-firestore.mjs) fetch the rows for
// the period and hand them here, so the dashboard reads the same either way.

/** Lowercased, punctuation-free form, for counting "the same question". */
export const normalizeQuestion = (q) => String(q).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {object} rows
 * @param {object[]} rows.turns   turns in the period, oldest first, each with the asker's `role`
 * @param {object[]} rows.events  events in the period: { type, turnId, ref, data, role }
 * @param {object[]} rows.calls   AI calls in the period: { at, purpose, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }
 * @param {object[]} rows.promotions  every promotion (listPromotions())
 * @param {string|null} rows.spendSince  when spend tracking began (the first AI call ever)
 * @param {boolean} rows.demoData  any demo rows in the database
 */
export function computeInsights({ days, role, turns, events, calls, promotions, spendSince, demoData }) {
  const byDay = new Map();
  const topicCount = new Map();
  const topicRole = new Map();
  const roleCount = new Map();
  const users = new Set();
  let up = 0, down = 0, low = 0, errors = 0;
  for (const t of turns) {
    const d = t.at.slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
    users.add(t.userId);
    const r = t.role || 'unknown';
    roleCount.set(r, (roleCount.get(r) || 0) + 1);
    for (const tp of t.topics) {
      topicCount.set(tp, (topicCount.get(tp) || 0) + 1);
      const k = `${tp}\u0000${r}`;
      topicRole.set(k, (topicRole.get(k) || 0) + 1);
    }
    if (t.feedback > 0) up++;
    if (t.feedback < 0) down++;
    if (t.lowConfidence) low++;
    if (t.error) errors++;
  }

  // Questions asked again in other words: the same person, same
  // conversation, within 3 minutes, on a shared topic, without having
  // opened a source from the first answer.
  const clicked = new Set(events.filter((e) => e.type === 'citation_click').map((e) => e.turnId));
  const rephrased = new Set();
  const byConv = new Map();
  for (const t of turns) (byConv.get(t.conversationId) || byConv.set(t.conversationId, []).get(t.conversationId)).push(t);
  for (const list of byConv.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const gap = Date.parse(b.at) - Date.parse(a.at);
      const shared = a.topics.some((x) => b.topics.includes(x));
      if (gap < 180_000 && shared && !clicked.has(a.id)) rephrased.add(a.id);
    }
  }

  const trouble = turns
    .filter((t) => t.lowConfidence || t.feedback < 0 || t.error || rephrased.has(t.id))
    .reverse()
    .slice(0, 300)
    .map((t) => ({
      id: t.id, at: t.at, role: t.role, question: t.question, topics: t.topics, confidence: t.confidence,
      reasons: [t.lowConfidence && 'weak match', t.feedback < 0 && 'thumbs down', t.error && 'error', rephrased.has(t.id) && 'asked again'].filter(Boolean),
      note: t.feedbackNote,
    }));

  // Every rating, with what the person wrote, newest first.
  const feedback = turns
    .filter((t) => t.feedback)
    .reverse()
    .slice(0, 300)
    .map((t) => ({
      id: t.id, at: t.at, role: t.role, question: t.question, topics: t.topics,
      answer: t.answer ? t.answer.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').slice(0, 1200) : null,
      value: t.feedback, note: t.feedbackNote,
    }));

  // Where people end up: sources opened from answers.
  const opened = new Map();
  for (const e of events.filter((x) => x.type === 'citation_click')) {
    const d = e.data || {};
    const key = d.title || e.ref;
    const o = opened.get(key) || { title: key, kind: d.kind, url: d.url, count: 0 };
    o.count++;
    opened.set(key, o);
  }

  // Top questions (same normalized text).
  const qs = new Map();
  for (const t of turns) {
    const k = normalizeQuestion(t.question);
    const g = qs.get(k) || { question: t.question, count: 0, roles: new Set(), topics: t.topics };
    g.count++; g.roles.add(t.role || 'unknown');
    qs.set(k, g);
  }

  const spend = {
    cost: 0, calls: calls.length, unpriced: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byDay: new Map(), byPurpose: new Map(), byModel: new Map(),
  };
  const add = (m, key, c) => { const g = m.get(key) || { key, calls: 0, cost: 0, output: 0 }; g.calls++; g.cost += c.costUsd || 0; g.output += c.outputTokens; m.set(key, g); };
  for (const c of calls) {
    if (c.costUsd == null) spend.unpriced++;
    spend.cost += c.costUsd || 0;
    spend.tokens.input += c.inputTokens; spend.tokens.output += c.outputTokens;
    spend.tokens.cacheRead += c.cacheReadTokens; spend.tokens.cacheWrite += c.cacheWriteTokens;
    const d = c.at.slice(0, 10);
    spend.byDay.set(d, (spend.byDay.get(d) || 0) + (c.costUsd || 0));
    add(spend.byPurpose, c.purpose, c);
    add(spend.byModel, c.model || 'unknown', c);
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.cost - a.cost);

  const promos = promotions.map((p) => {
    const ev = events.filter((e) => Number(e.ref) === p.id);
    return { ...p, shown: ev.filter((e) => e.type === 'promo_shown').length, clicked: ev.filter((e) => e.type === 'promo_click').length, linkOpens: ev.filter((e) => e.type === 'promo_link_click').length };
  });

  return {
    days, role,
    demoData,
    totals: { questions: turns.length, users: users.size, up, down, comments: turns.filter((t) => t.feedback && t.feedbackNote).length, lowConfidence: low, errors, rephrased: rephrased.size },
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
    recent: turns.slice(-300).reverse().map((t) => ({ id: t.id, at: t.at, role: t.role, question: t.question, topics: t.topics, feedback: t.feedback, note: t.feedbackNote, lowConfidence: !!t.lowConfidence })),
    promotions: promos,
    spend: {
      ...spend,
      // Claude-answered questions since spend tracking began, for cost per answer.
      answered: turns.filter((t) => t.mode === 'claude' && !t.error && spendSince && t.at >= spendSince).length,
      since: spendSince,
      byDay: [...spend.byDay].map(([day, cost]) => ({ day, cost })),
      byPurpose: sorted(spend.byPurpose),
      byModel: sorted(spend.byModel),
    },
  };
}

/** Topic counts from a person's turns (oldest first), with when each was last asked. */
export function topicCounts(turns) {
  const counts = new Map();
  for (const t of turns) {
    for (const name of t.topics) {
      const c = counts.get(name) || { topic: name, count: 0, lastAt: null };
      c.count++; c.lastAt = t.at;
      counts.set(name, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

/**
 * Most-asked questions among others in a role, skipping topics in `mine`.
 * `rows` are their eligible turns: { question, topics, userId }.
 */
export function groupPeerQuestions(rows, mine, limit) {
  const groups = new Map();
  for (const r of rows) {
    if (r.topics.some((x) => mine.has(x))) continue;
    const key = normalizeQuestion(r.question);
    const g = groups.get(key) || { question: r.question, topics: r.topics, people: new Set(), count: 0 };
    g.people.add(r.userId); g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.people.size - a.people.size || b.count - a.count)
    .slice(0, limit)
    .map((g) => ({ question: g.question, topics: g.topics, people: g.people.size }));
}

/** History-panel rows from a person's visible turns (any order). */
export function groupConversations(turns, limit) {
  const byConv = new Map();
  for (const t of [...turns].sort((a, b) => a.id - b.id)) {
    const c = byConv.get(t.conversationId) || { conversationId: t.conversationId, startedAt: t.at, lastAt: t.at, turns: 0, title: t.question };
    if (t.at < c.startedAt) c.startedAt = t.at;
    if (t.at > c.lastAt) c.lastAt = t.at;
    c.turns++;
    byConv.set(t.conversationId, c);
  }
  return [...byConv.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}

/** Active, in-date promotions aimed at this role (or everyone), best first. */
export const activePromotions = (list, role, day) => list.filter((p) => p.active
  && (!p.starts || p.starts <= day) && (!p.ends || p.ends >= day)
  && (!p.roles.length || p.roles.includes(role)));
