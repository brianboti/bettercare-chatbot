// Personalization: what Sophia knows about the person, and the welcome
// screen built from it.
//
// The welcome is assembled in two steps:
//   1. candidates, chosen in code from four sources
//        org       content Clinical IT wants to push to this role (promotions)
//        continue  building on what this person asked before
//        peers     what other people in the same role ask
//        new       recent news and upcoming events on the site
//   2. Claude writes the greeting and phrases each card as an offer
//      ("Want the 2-minute version of Dr. Sankary's podcast?"). Without an
//      API key the cards keep their plain titles.
//
// Claude can only pick and phrase candidates; it can't invent content, so
// every card leads to something the site actually has.

import { ROLES, roleLabel, tagTopics } from './topics.mjs';
import { llmAvailable, generateJson } from './llm.mjs';

const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

/** The <person> block given to the model with every question. */
export function describePerson(store, user) {
  if (!user) return '';
  const lines = [];
  if (user.name) lines.push(`Name: ${user.name}`);
  lines.push(`Role: ${roleLabel(user.role) || 'not given'}${user.department ? `, ${user.department}` : ''}`);
  const topics = store.userTopics(user.id, 60).slice(0, 4);
  if (topics.length) lines.push(`Asked about recently: ${topics.map((t) => `${t.topic} (${t.count}×, last ${fmtDay(t.lastAt)})`).join('; ')}`);
  const recent = store.recentTurns(user.id, 4);
  if (recent.length) {
    lines.push('Last questions:');
    for (const t of recent) lines.push(`- ${fmtDay(t.at)}: ${t.question.slice(0, 160)}`);
  } else {
    lines.push('First conversation with Sophia.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- candidates

/** Recent news and upcoming events, one entry per source. */
function siteNews(chunks, { pastDays = 75, aheadDays = 60 } = {}) {
  const today = todayIso();
  const from = new Date(Date.now() - pastDays * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + aheadDays * 86_400_000).toISOString().slice(0, 10);
  const seen = new Map();
  for (const c of chunks) {
    if (c.kind !== 'news' && c.kind !== 'event' && c.kind !== 'announcement') continue;
    const d = (c.meta?.date || c.meta?.published || '').slice(0, 10);
    if (!d) continue;
    // News counts when recent; events only when still ahead.
    if (c.kind === 'event' ? !(d >= today && d <= to) : !(d >= from && d <= today)) continue;
    const key = c.title.toLowerCase();
    if (!seen.has(key)) seen.set(key, { title: c.title, date: d, kind: c.kind, text: c.text.slice(0, 300), topics: tagTopics(`${c.title} ${c.text}`, 3) });
  }
  return [...seen.values()];
}

/**
 * Pick up to ~8 candidates for the welcome screen.
 * @returns {{ id, source, title, detail, prompt, promoId? }[]}
 */
export function welcomeCandidates(store, user, { chunks, facts }) {
  const out = [];
  const role = ROLES[user.role] ? user.role : null;
  const roleTopics = new Set(ROLES[role]?.topics || []);
  const mine = store.userTopics(user.id, 60);
  const myTopics = new Set(mine.map((t) => t.topic));

  // 1. What the org wants this role to see. Not re-shown once clicked or dismissed.
  const acted = store.promotionsActedOn(user.id);
  for (const p of store.promotionsFor(role).filter((x) => !acted.has(x.id)).slice(0, 2)) {
    out.push({ id: `org:${p.id}`, source: 'org', promoId: p.id, title: p.title, detail: p.blurb || '', prompt: p.prompt, url: p.url || null });
  }

  // 2. Build on what they asked before.
  if (mine.length) {
    const top = mine[0];
    const last = store.recentTurns(user.id, 20).find((t) => t.topics.includes(top.topic));
    out.push({
      id: `continue:${top.topic}`, source: 'continue', title: top.topic,
      detail: `They asked about ${top.topic} ${top.count} time${top.count > 1 ? 's' : ''}, most recently on ${fmtDay(top.lastAt)}: "${last?.question || ''}". Suggest a natural next step on the same topic, not the same question.`,
      prompt: `What else should I know about ${top.topic}${last ? ` now that I've looked into "${last.question.slice(0, 80)}"` : ''}?`,
    });
  }

  // 3. What people in the same role ask.
  for (const pq of store.peerQuestions(role, user.id, { limit: 2 })) {
    out.push({
      id: `peers:${pq.question.slice(0, 40)}`, source: 'peers', title: pq.question,
      detail: `${pq.people} other ${roleLabel(role) || 'people'} asked this recently.`, prompt: pq.question,
    });
  }

  // 4. New on the site: the next Epic upgrade, then news and events that fit
  //    this person's role or interests.
  const next = facts?.context?.().next;
  if (next) {
    out.push({
      id: `new:upgrade:${next.version}`, source: 'new', title: `Epic upgrade ${next.version}`,
      detail: `The next Epic upgrade, ${next.version}, goes live ${next.date}.`,
      prompt: `What's changing for ${roleLabel(role)?.toLowerCase() || 'me'} in the ${next.version} upgrade?`,
    });
  }
  const scored = siteNews(chunks)
    .map((n) => ({ ...n, score: n.topics.filter((t) => roleTopics.has(t)).length * 2 + n.topics.filter((t) => myTopics.has(t)).length + (n.date >= todayIso() ? 0.5 : 0) }))
    .filter((n) => n.score > 0 || /podcast/i.test(n.title))
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, 3);
  for (const n of scored) {
    out.push({
      id: `new:${n.title.slice(0, 40)}`, source: 'new', title: n.title,
      detail: `${n.kind === 'event' ? 'Upcoming event' : 'Posted'} ${n.date}. ${n.text}`,
      prompt: n.kind === 'event' ? `Tell me about "${n.title}" on ${n.date}.` : `Summarize "${n.title}".`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- welcome

const WELCOME_SYSTEM = `You write the welcome screen of Sophia, the assistant for UT Health San Antonio's BetterCare site (Clinical IT: Epic, Abridge, training, upgrades, AI).

You get the person and a list of candidate suggestions. Write:
- greeting: one warm, plain sentence using their first name if known, under 90 characters. No exclamation marks stacked, no emoji.
- cards: pick the 3 or 4 candidates this person would most likely care about, in that order. Always include "org" candidates. Prefer variety across sources. For each, write a label: a short offer or question in Sophia's voice, under 70 characters, e.g. "Want the 2-minute version of Dr. Sankary's podcast?", "Are you here about the vMay2026 upgrade?", "Other nurses are asking how to cover an In Basket". For "continue" candidates, suggest a sensible next step on that topic. For "peers", make clear others in their role ask it. Also write the prompt: the question Sophia will be asked when the card is clicked, in first person, answerable from the site.

Use only the candidates given. Don't invent content, dates or names.`;

const WELCOME_SCHEMA = {
  type: 'object',
  properties: {
    greeting: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' }, prompt: { type: 'string' } },
        required: ['id', 'label', 'prompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['greeting', 'cards'],
  additionalProperties: false,
};

const LEAD = { org: 'New', continue: 'For you', peers: 'People like you', new: 'On the site' };

function plainWelcome(user, candidates) {
  const first = user.name?.split(/\s+/)[0];
  const bySource = (s) => candidates.filter((c) => c.source === s);
  const picked = [...bySource('org'), ...bySource('continue'), ...bySource('peers').slice(0, 1), ...bySource('new').slice(0, 1)].slice(0, 4);
  return {
    greeting: first ? `Welcome back, ${first}. What can I find for you?` : 'What can I find for you today?',
    cards: picked.map((c) => ({ id: c.id, label: c.title, prompt: c.prompt })),
  };
}

const cache = new Map();   // userId -> { key, value }

/**
 * The personalized welcome: { greeting, cards: [{ id, source, lead, label, prompt, promoId? }] }.
 * Cached per user until they ask something new or the pushed content changes.
 */
export async function welcome(store, user, deps) {
  const key = [todayIso(), store.recentTurns(user.id, 1)[0]?.id || 0, JSON.stringify(store.promotionsFor(user.role).map((p) => [p.id, p.url])), user.role, user.name].join('|');
  const hit = cache.get(user.id);
  if (hit?.key === key) return hit.value;

  const candidates = welcomeCandidates(store, user, deps);
  let result = null;
  if (llmAvailable() && candidates.length) {
    const content = `<person>\n${describePerson(store, user)}\n</person>\n\n<candidates>\n${candidates.map((c) => JSON.stringify({ id: c.id, source: c.source, title: c.title, detail: c.detail, default_prompt: c.prompt })).join('\n')}\n</candidates>`;
    try { result = await generateJson(WELCOME_SYSTEM, content, WELCOME_SCHEMA, { purpose: 'welcome', userId: user.id }); } catch (e) { console.warn('welcome generation failed:', e.message); }
  }
  if (!result?.cards?.length) result = plainWelcome(user, candidates);

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const cards = result.cards
    .filter((c) => byId.has(c.id))
    .slice(0, 4)
    .map((c) => {
      const cand = byId.get(c.id);
      return { id: c.id, source: cand.source, lead: LEAD[cand.source], label: c.label.slice(0, 90), prompt: (c.prompt || cand.prompt).slice(0, 300), promoId: cand.promoId, url: cand.url || undefined };
    });
  const value = { greeting: result.greeting.slice(0, 140), cards };
  cache.set(user.id, { key, value });
  return value;
}
