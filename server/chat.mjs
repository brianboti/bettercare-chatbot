// One chat turn: rewrite -> retrieve -> prompt -> stream.
//
// SSE protocol (see extension/lib/chat-api.js). Every stream ends in exactly
// one `error` or one `done`.
//
// Every answer opens with Sophia's assumptions, cites every bullet, and ends
// with where to get human help (the Health IT Help Desk).

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.mjs';
import { ROOT } from './corpus.mjs';
import { PROMPT_VERSION, buildUserTurn } from './prompt.mjs';
import { VERSION } from './version.mjs';
import { llmAvailable, rewriteQuery, streamAnswer, Anthropic } from './llm.mjs';
import { OpenAI } from './openai.mjs';
import { SuggestionSplitter, AssumptionSplitter } from './followups.mjs';
import { repairCitations } from './citations.mjs';
import { helpLine, hasHelp, withHelpSource, HELP_SOURCE_ID } from './help.mjs';
import { tagTopics } from './topics.mjs';
import { describePerson } from './personalize.mjs';
import { orderByRecency } from './recency.mjs';

const LOG_DIR = resolve(ROOT, 'data/logs');

export class ChatError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Validate and normalize the request body's message history. */
export function parseMessages(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs?.length) throw new ChatError('BAD_REQUEST', 'messages must be a non-empty array');
  const clean = msgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? config.MAX_QUESTION_CHARS : 6000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') throw new ChatError('BAD_REQUEST', 'the last message must be from the user');
  // Keep the tail, starting on a user turn, and merge same-role neighbours.
  let tail = clean.slice(-config.MAX_HISTORY_TURNS * 2);
  while (tail[0]?.role !== 'user') tail = tail.slice(1);
  const merged = [];
  for (const m of tail) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/** What the client needs to render a citation. */
export function sourceView(c, n, older = false) {
  return {
    n,
    id: c.id,
    title: c.title,
    headingPath: c.headingPath || [],
    kind: c.kind,
    sourceType: c.sourceType,
    list: c.list,
    url: c.url,
    localUrl: c.localUrl,
    docUrl: c.docUrl || null,
    date: c.meta?.date || c.meta?.published || null,
    updated: c.meta?.date || c.meta?.published ? null : c.meta?.modified || null,
    older: older || undefined,
    // The text usually opens with the title; don't repeat it in the snippet.
    snippet: c.text.replace(/\s+/g, ' ').replace(new RegExp(`^${c.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, ' ')}\\s*`, 'i'), '').slice(0, 220),
    score: c.score,
    retrievedBy: c.retrievedBy,
  };
}

/**
 * @param {object} deps  { retriever, store }
 * @param {{role,content}[]} messages
 * @param {(event:string, data:any) => void} send
 * @param {AbortSignal} signal
 * @param {{ user?: object, conversationId?: string }} ctx  who is asking; the turn is saved to their history
 */
export async function runChat({ retriever, store }, messages, send, signal, { user = null, conversationId = null } = {}) {
  const t0 = Date.now();
  const question = messages[messages.length - 1].content;
  const history = messages.slice(0, -1);
  const useLlm = llmAvailable();
  const log = { at: new Date().toISOString(), version: VERSION, question, promptVersion: PROMPT_VERSION, user: user?.id || null };
  const person = user && store ? describePerson(store, user) : '';
  const turn = { question, topics: [], intent: null, context: [], answer: '', sources: [], suggestions: null, assumptions: [] };
  let saved = null;
  const saveTurn = () => {
    if (!user || !store || saved) return saved;
    try {
      saved = store.addTurn({ ...turn, userId: user.id, conversationId: conversationId || `c-${Date.now()}`, rewritten: log.rewritten, latencyMs: Date.now() - t0 });
    } catch (e) { console.warn('could not save turn:', e.message); }
    return saved;
  };

  try {
    // 1. Search query. Follow-ups ("what about the second one?") retrieve
    //    garbage unless rewritten against the conversation, and everyday words
    //    ("phone") miss the site's vocabulary ("Haiku") unless expanded. The
    //    user's own words are searched too, and both result lists fused.
    const facts = retriever.facts.describe();
    let query = question;
    if (useLlm) {
      send('status', { stage: 'rewriting' });
      try {
        const r = await rewriteQuery(history, question, facts, person, { userId: user?.id });
        query = r.query; turn.topics = r.topics; turn.intent = r.intent; turn.context = r.context || [];
      } catch { /* fall back to the raw question */ }
    } else if (history.length) {
      query = `${history.filter((m) => m.role === 'user').slice(-1)[0]?.content || ''} ${question}`;
    }
    // Follow-ups ("shorter please") inherit the topic of the conversation.
    if (!turn.topics.length) turn.topics = tagTopics(question).length ? tagTopics(question) : tagTopics(query);
    log.rewritten = query; log.intent = turn.intent; log.topics = turn.topics; log.context = turn.context;

    // 2. Retrieve.
    send('status', { stage: 'retrieving', query });
    const queries = history.length ? [query] : [question, query];
    const broad = turn.intent === 'broad' || isBroad(question);
    const found = await retriever.retrieve(queries, broad
      ? { topK: config.BROAD_TOP_K, maxPerSource: config.BROAD_MAX_PER_SOURCE }
      : {});
    const { confidence, lowConfidence } = found;
    // Newest first; much older matches are marked so they're shown last.
    const ordered = orderByRecency(found.results, { windowDays: config.RECENT_WINDOW_DAYS });
    const { older } = ordered;
    // The help desk contacts are always in the excerpts, last, for the help line.
    const results = withHelpSource(ordered.results, retriever);
    const helpN = results.findIndex((c) => c.id === HELP_SOURCE_ID) + 1;
    const withHelp = (answer) => (helpN && !hasHelp(answer) ? `${answer}\n\n${helpLine(helpN)}` : answer);
    log.broad = broad;
    log.retrieved = results.map((r) => ({ id: r.id, score: r.score, cos: r.cosine && +r.cosine.toFixed(3), by: r.retrievedBy }));
    log.confidence = confidence;
    turn.confidence = confidence; turn.lowConfidence = lowConfidence;

    // Out of scope: the question is unrelated to the site AND nothing on the
    // site matches it. Answer with a fixed reply instead of asking the model,
    // so Sophia never answers from general knowledge.
    if (isOutOfScope(turn.intent, lowConfidence)) {
      const footer = retriever.get?.(HELP_SOURCE_ID);
      turn.sources = footer ? [sourceView(footer, 1)] : [];
      turn.answer = footer ? `${OUT_OF_SCOPE_ANSWER}\n\n${helpLine(1)}` : OUT_OF_SCOPE_ANSWER;
      turn.mode = 'out-of-scope';
      log.outOfScope = true;
      send('sources', turn.sources);
      send('token', { text: turn.answer });
      const turnId = saveTurn();
      send('done', { finishReason: 'out_of_scope', mode: 'out-of-scope', model: null, promptVersion: PROMPT_VERSION, rewrittenQuery: query, confidence, latencyMs: Date.now() - t0, turnId });
      return;
    }

    turn.sources = results.map((c, i) => sourceView(c, i + 1, older.has(c.id)));
    send('sources', turn.sources);

    // 3. Generate.
    if (!useLlm) {
      send('status', { stage: 'generating' });
      turn.answer = withHelp(extractiveAnswer(results, lowConfidence));
      turn.mode = 'retrieval-only';
      send('token', { text: turn.answer });
      const turnId = saveTurn();
      send('done', { finishReason: 'retrieval_only', mode: 'retrieval-only', model: null, promptVersion: PROMPT_VERSION, rewrittenQuery: query, confidence, latencyMs: Date.now() - t0, turnId });
      return;
    }

    send('status', { stage: 'generating' });
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const apiMessages = [
      ...history,
      { role: 'user', content: buildUserTurn(question, results, { lowConfidence, today, facts, broad, person, said: turn.context, intent: turn.intent, older }) },
    ];
    // The leading <assumptions> and trailing <suggestions> blocks are cut out
    // of the visible stream and sent as their own events.
    const onAssumptions = (a) => { turn.assumptions = a; if (a.length) send('assumptions', a); };
    let lead = new AssumptionSplitter(onAssumptions);
    let split = new SuggestionSplitter();
    const show = (text) => { const shown = split.push(text); if (shown) { turn.answer += shown; send('token', { text: shown }); } };
    const out = await streamAnswer(apiMessages, {
      onText: (text) => { const rest = lead.push(text); if (rest) show(rest); },
      onReset: () => { lead = new AssumptionSplitter(onAssumptions); split = new SuggestionSplitter(); turn.answer = ''; turn.assumptions = []; send('reset', {}); },
    }, signal, { userId: user?.id });
    const rest = lead.finish();
    if (rest) show(rest);
    const tail = split.finish();
    if (tail.text) { turn.answer += tail.text; send('token', { text: tail.text }); }
    turn.answer = turn.answer.trimEnd();
    log.assumptions = turn.assumptions.length;

    // Cite any bullet the model left bare, then add the help line. The client
    // swaps in the final text.
    const fixed = repairCitations(turn.answer, results);
    log.citationsAdded = fixed.added;
    if (fixed.unresolved.length) log.uncited = fixed.unresolved;
    const final = out.stopReason === 'refusal' ? turn.answer : withHelp(fixed.text);
    if (final !== turn.answer) { turn.answer = final; send('answer', { text: final }); }
    turn.suggestions = tail.suggestions;
    if (tail.suggestions) send('suggestions', tail.suggestions);
    log.model = out.model; log.usage = out.usage; log.stopReason = out.stopReason;
    turn.mode = 'claude';

    if (out.stopReason === 'refusal') {
      turn.error = 'refused';
      saveTurn();
      send('error', { code: 'REFUSED', message: "I can't help with that one. Try rephrasing, or search the site directly." });
      return;
    }
    const turnId = saveTurn();
    send('done', {
      finishReason: out.stopReason, mode: 'claude', model: out.model, promptVersion: PROMPT_VERSION,
      rewrittenQuery: query, confidence, latencyMs: Date.now() - t0, turnId,
    });
  } catch (err) {
    if (signal?.aborted) return;
    log.error = String(err?.message || err);
    turn.error = log.error.slice(0, 300);
    saveTurn();
    const code = err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError ? 'RATE_LIMITED'
      : err instanceof Anthropic.APIError || err instanceof OpenAI.APIError || /^OpenAI:/.test(err?.message) ? 'UPSTREAM_LLM'
      : 'INTERNAL';
    send('error', { code, message: code === 'INTERNAL' ? 'Something went wrong on the server.' : 'The AI service had a problem. Please try again.' });
  } finally {
    log.latencyMs = Date.now() - t0;
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(resolve(LOG_DIR, 'chat.jsonl'), `${JSON.stringify(log)}\n`);
    } catch { /* logging must never break a turn */ }
  }
}

export const OUT_OF_SCOPE_ANSWER = "That information doesn't exist in the BetterCare documents, so I can't answer it. I can help with Epic upgrades, training and tip sheets, Abridge, Haiku and Canto, Wisdom dental, Beaker lab, AI in healthcare, and the help desk.";

/** Skip the model when the question is unrelated to the site and retrieval found nothing close. */
export function isOutOfScope(intent, lowConfidence) {
  return intent === 'offtopic' && lowConfidence;
}

/** "What's new for surgeons", "summarize the upgrade", "everything about X". */
export function isBroad(q) {
  return /\b(what('?s| is| are)? new|what changed|changes|summar\w*|overview|highlights?|everything|all (the )?(changes|features|updates)|key features|need to know|should .* know)\b/i.test(q);
}

/** No-LLM mode: present the best matches verbatim, with citations. */
export function extractiveAnswer(results, lowConfidence) {
  if (!results.length || lowConfidence) {
    return "That information doesn't exist in the BetterCare documents. The closest matches are listed below.";
  }
  const top = results.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => c.id !== HELP_SOURCE_ID).slice(0, 3).map(({ c, n }) => {
    const body = c.text.replace(/\n+/g, ' ').slice(0, 320);
    return `- **${c.title}** — ${body}${c.text.length > 320 ? '…' : ''} [${n}]`;
  });
  return `Here's what I found on the site:\n${top.join('\n')}`;
}
