// One chat turn: rewrite -> retrieve -> prompt -> stream.
//
// SSE protocol (see extension/lib/chat-api.js). Every stream ends in exactly
// one `error` or one `done`.

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.mjs';
import { ROOT } from './corpus.mjs';
import { PROMPT_VERSION, buildUserTurn } from './prompt.mjs';
import { llmAvailable, rewriteQuery, streamAnswer, Anthropic } from './llm.mjs';

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
export function sourceView(c, n) {
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
    // The text usually opens with the title; don't repeat it in the snippet.
    snippet: c.text.replace(/\s+/g, ' ').replace(new RegExp(`^${c.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, ' ')}\\s*`, 'i'), '').slice(0, 220),
    score: c.score,
    retrievedBy: c.retrievedBy,
  };
}

/**
 * @param {object} deps  { retriever }
 * @param {{role,content}[]} messages
 * @param {(event:string, data:any) => void} send
 * @param {AbortSignal} signal
 */
export async function runChat({ retriever }, messages, send, signal) {
  const t0 = Date.now();
  const question = messages[messages.length - 1].content;
  const history = messages.slice(0, -1);
  const useLlm = llmAvailable();
  const log = { at: new Date().toISOString(), question, promptVersion: PROMPT_VERSION };

  try {
    // 1. Search query. Follow-ups ("what about the second one?") retrieve
    //    garbage unless rewritten against the conversation, and everyday words
    //    ("phone") miss the site's vocabulary ("Haiku") unless expanded. The
    //    user's own words are searched too, and both result lists fused.
    let query = question;
    if (useLlm) {
      send('status', { stage: 'rewriting' });
      try { query = await rewriteQuery(history, question); } catch { /* fall back to the raw question */ }
    } else if (history.length) {
      query = `${history.filter((m) => m.role === 'user').slice(-1)[0]?.content || ''} ${question}`;
    }
    log.rewritten = query;

    // 2. Retrieve.
    send('status', { stage: 'retrieving', query });
    const queries = history.length ? [query] : [question, query];
    const { results, confidence, lowConfidence } = await retriever.retrieve(queries);
    log.retrieved = results.map((r) => ({ id: r.id, score: r.score, cos: r.cosine && +r.cosine.toFixed(3), by: r.retrievedBy }));
    log.confidence = confidence;
    send('sources', results.map((c, i) => sourceView(c, i + 1)));

    // 3. Generate.
    if (!useLlm) {
      send('status', { stage: 'generating' });
      send('token', { text: extractiveAnswer(results, lowConfidence) });
      send('done', { finishReason: 'retrieval_only', mode: 'retrieval-only', model: null, promptVersion: PROMPT_VERSION, rewrittenQuery: query, confidence, latencyMs: Date.now() - t0 });
      return;
    }

    send('status', { stage: 'generating' });
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const apiMessages = [
      ...history,
      { role: 'user', content: buildUserTurn(question, results, { lowConfidence, today }) },
    ];
    let answer = '';
    const out = await streamAnswer(apiMessages, {
      onText: (text) => { answer += text; send('token', { text }); },
      onReset: () => { answer = ''; send('reset', {}); },
    }, signal);
    log.model = out.model; log.usage = out.usage; log.stopReason = out.stopReason;

    if (out.stopReason === 'refusal') {
      send('error', { code: 'REFUSED', message: "I can't help with that one. Try rephrasing, or search the site directly." });
      return;
    }
    send('done', {
      finishReason: out.stopReason, mode: 'claude', model: out.model, promptVersion: PROMPT_VERSION,
      rewrittenQuery: query, confidence, latencyMs: Date.now() - t0,
    });
  } catch (err) {
    if (signal?.aborted) return;
    log.error = String(err?.message || err);
    const code = err instanceof Anthropic.RateLimitError ? 'RATE_LIMITED'
      : err instanceof Anthropic.APIError ? 'UPSTREAM_LLM'
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

/** No-LLM mode: present the best matches verbatim, with citations. */
function extractiveAnswer(results, lowConfidence) {
  if (!results.length || lowConfidence) {
    return "I couldn't find a clear answer on the BetterCare site. The closest matches are listed below.";
  }
  const top = results.slice(0, 3).map((c, i) => {
    const body = c.text.replace(/\n+/g, ' ').slice(0, 320);
    return `- **${c.title}** — ${body}${c.text.length > 320 ? '…' : ''} [${i + 1}]`;
  });
  return `Here's what I found on the site:\n${top.join('\n')}`;
}
