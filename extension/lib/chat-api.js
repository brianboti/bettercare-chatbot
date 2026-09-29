// Client for the Sophia RAG backend. No DOM, no dependencies.
//
// Shared by the Chrome extension side panel and the local site replica (the
// server serves this same file at /lib/chat-api.js), so both surfaces speak the
// protocol through one implementation.
//
// SSE protocol (POST /api/chat) — every stream ends in exactly one `error` or `done`:
//   status   { stage: 'rewriting' | 'retrieving' | 'generating', query? }
//   sources  [{ n, id, title, headingPath, kind, sourceType, list, url, localUrl, docUrl, date, snippet, score, retrievedBy }]
//   token    { text }
//   suggestions { kind: 'reply' | 'followup', items: string[] }   quick replies to Sophia's question, or next questions
//   reset    {}   the model declined mid-answer and a fallback model took over: clear the text
//   error    { code, message }
//   done     { finishReason, mode, model, promptVersion, rewrittenQuery, confidence, latencyMs, turnId }
//
// Who is asking travels in the X-Sophia-User header (see userHeaders).

export const DEFAULT_API = 'http://localhost:8787';

/** GET /api/health. Resolves to null if the server is unreachable. */
export async function health(api = DEFAULT_API, { timeoutMs = 2500 } = {}) {
  try {
    const res = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Headers identifying the signed-in user, or none. */
export const userHeaders = (userId) => (userId ? { 'X-Sophia-User': userId } : {});

/** JSON GET/POST to the backend. Resolves to null on any failure. */
export async function apiJson(api, path, { userId, body, method } = {}) {
  try {
    const res = await fetch(`${api}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...userHeaders(userId), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** GET /api/search — hybrid (keyword + semantic) retrieval, no LLM. */
export async function searchApi(api, q, k = 10) {
  const res = await fetch(`${api}/api/search?q=${encodeURIComponent(q)}&k=${k}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json();
}

/**
 * POST /api/chat and dispatch SSE events to handlers.
 *
 * @param {string} api          base URL
 * @param {{role:'user'|'assistant', content:string}[]} messages  full history, last is the new question
 * @param {object} on           { status, sources, token, suggestions, reset, error, done } — each optional
 * @param {AbortSignal} [signal]
 * @param {{ userId?: string, conversationId?: string }} [opts]  saves the turn to this user's history
 */
export async function streamChat(api, messages, on = {}, signal, { userId, conversationId } = {}) {
  let terminal = false;
  const emit = (event, data) => {
    if (event === 'error' || event === 'done') terminal = true;
    on[event]?.(data);
  };

  let res;
  try {
    res = await fetch(`${api}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...userHeaders(userId) },
      body: JSON.stringify({ messages, conversationId }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    emit('error', { code: 'UNREACHABLE', message: `Can't reach the assistant server at ${api}.` });
    return;
  }

  if (!res.ok || !res.body) {
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    emit('error', body?.code ? body : { code: 'INTERNAL', message: `Server returned ${res.status}.` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Events are separated by a blank line.
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        const data = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try { emit(event, JSON.parse(data.join('\n'))); } catch { /* malformed event */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }

  // A stream that closes without a terminal event would otherwise hang the UI.
  if (!terminal && !signal?.aborted) {
    emit('error', { code: 'INTERNAL', message: 'The connection closed before the answer finished.' });
  }
}

/**
 * Split answer text into plain strings and citation markers, so a renderer can
 * turn "[2]" or "[1, 3]" into links without using innerHTML.
 * Returns [{ text } | { cite: number }].
 */
export function splitCitations(text) {
  const out = [];
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    for (const n of m[1].split(',')) out.push({ cite: Number(n.trim()) });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
