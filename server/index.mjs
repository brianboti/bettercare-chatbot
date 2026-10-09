#!/usr/bin/env node
// Sophia assistant server (answers from the BetterCare site).
//
//   npm start            (node --env-file-if-exists=.env server/index.mjs)
//
//   GET  /api/health     version, mode, model, corpus size
//   GET  /api/search     hybrid retrieval, no LLM   ?q=...&k=10
//   POST /api/chat       SSE answer stream           { messages: [{role, content}], conversationId? }
//   GET  /api/me         the signed-in user (X-Sophia-User header)   POST: save profile
//   GET  /api/welcome    personalized greeting + suggestion cards
//   GET  /api/history    past conversations          /api/history/<conversationId>: its turns
//   POST /api/feedback   { turnId, value: 1|-1|0, note? }   (0 clears it)
//   POST /api/events     { type, turnId?, ref?, data? }   usage events for insights
//   GET  /api/admin/insights, GET|POST /api/admin/promotions   (admins only)
//   GET  /api/admin/tests, POST /api/admin/tests/run { suite }  (admins only)
//   GET  /admin          the insights dashboard
//   GET  /lib/*          shared client modules (extension/lib)
//   GET  /*              the local site replica (site/)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { config } from './config.mjs';
import { ROOT, loadChunks } from './corpus.mjs';
import { buildRetriever } from './retriever.mjs';
import { runChat, parseMessages, sourceView, ChatError } from './chat.mjs';
import { llmAvailable, onUsage, providers } from './llm.mjs';
import { PROMPT_VERSION } from './prompt.mjs';
import { VERSION } from './version.mjs';
import { openStore } from './store.mjs';
import { welcome } from './personalize.mjs';
import { ROLES } from './topics.mjs';
import { testStatus, startRun } from './testrunner.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ---------------------------------------------------------------- startup

console.log('loading corpus…');
const chunks = loadChunks();
const retriever = await buildRetriever(chunks, { log: (m) => console.log(m) });
const site = await import('../site/server.mjs').catch((e) => { console.warn('site replica disabled:', e.message); return null; });
site?.init?.({ chunks });
const store = openStore(config.DB_FILE);
onUsage((c) => store.addLlmCall(c));

// ---------------------------------------------------------------- helpers

function cors(req) {
  const o = req.headers.origin || '';
  const ok = o.startsWith('chrome-extension://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
    || o === 'https://uthealthsa.sharepoint.com';
  return ok ? {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Sophia-User',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  } : {};
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

/** Serve a file from under `base`, refusing anything outside it. */
export function serveFile(req, res, base, rel, headers = {}) {
  let path;
  try { path = resolve(base, decodeURIComponent(rel).replace(/^\/+/, '')); } catch { res.writeHead(400).end(); return true; }
  if (!path.startsWith(base + sep) && path !== base) { res.writeHead(403).end(); return true; }
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  // Range support so video and large PDFs stream.
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Type': headers['Content-Type'] || type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Type': headers['Content-Type'] || type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res);
  }
  return true;
}

async function readBody(req, limit = 256_000) {
  let body = '';
  for await (const c of req) {
    body += c;
    if (body.length > limit) throw new ChatError('BAD_REQUEST', 'request too large', 413);
  }
  try { return JSON.parse(body || '{}'); } catch { throw new ChatError('BAD_REQUEST', 'invalid JSON'); }
}

// Per-client sliding-window rate limit on /api/chat.
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW_MIN * 60_000;
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= config.RATE_LIMIT_MESSAGES) { hits.set(key, recent); return Math.ceil((recent[0] + windowMs - now) / 1000); }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}

// Who is asking. The demo trusts the X-Sophia-User header (set by the
// replica's "signed in as" switcher, or by the extension from the SharePoint
// user). Production replaces this with a validated Entra ID token.
function currentUser(req) {
  const id = String(req.headers['x-sophia-user'] || '').trim().toLowerCase().slice(0, 120);
  if (!/^[a-z0-9._@-]+$/.test(id)) return { id: null, user: null };
  const user = store.getUser(id);
  if (user) store.touchUser(id);
  return { id, user };
}

const EVENT_TYPES = new Set(['citation_click', 'suggestion_click', 'promo_click', 'promo_dismiss', 'promo_link_click', 'history_open', 'copy_answer', 'welcome_card_click']);

function requireAdmin(user) {
  if (!user?.isAdmin) throw new ChatError('FORBIDDEN', 'Admins only.', 403);
}

// ---------------------------------------------------------------- routes

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const h = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, h).end(); return; }

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        mode: llmAvailable() ? 'claude' : 'retrieval-only',
        model: llmAvailable() ? config.ANTHROPIC_MODEL : null,
        providers: providers(),
        chunks: chunks.length,
        sources: new Set(chunks.map((c) => c.sourceId)).size,
        promptVersion: PROMPT_VERSION,
      }, h);
    }

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, config.MAX_QUESTION_CHARS);
      const k = Math.min(30, Math.max(1, Number(url.searchParams.get('k')) || 10));
      if (!q) return json(res, 200, { query: q, results: [], ms: 0 }, h);
      const t0 = Date.now();
      const { results, confidence, lowConfidence } = await retriever.retrieve(q, { topK: k });
      return json(res, 200, { query: q, confidence, lowConfidence, results: results.map((c, i) => sourceView(c, i + 1)), ms: Date.now() - t0 }, h);
    }

    // What the site's current search does, for side-by-side demos: every word
    // must appear exactly as typed (no stemming, synonyms, or meaning).
    if (url.pathname === '/api/classic-search') {
      const words = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const results = !words.length ? [] : chunks
        .filter((c) => { const t = ` ${c.title} ${c.text} `.toLowerCase(); return words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)); })
        .slice(0, 20)
        .map((c) => ({ title: c.title, url: c.url }));
      return json(res, 200, { results }, h);
    }

    if (url.pathname === '/api/me') {
      const { id, user } = currentUser(req);
      if (req.method === 'POST') {
        if (!id) throw new ChatError('BAD_REQUEST', 'X-Sophia-User header required');
        const b = await readBody(req, 4000);
        const fields = {};
        if (typeof b.name === 'string') fields.name = b.name.trim().slice(0, 80) || null;
        if (typeof b.role === 'string') { if (!ROLES[b.role]) throw new ChatError('BAD_REQUEST', 'unknown role'); fields.role = b.role; }
        if (typeof b.department === 'string') fields.department = b.department.trim().slice(0, 80) || null;
        if (typeof b.email === 'string') fields.email = b.email.trim().slice(0, 120) || null;
        return json(res, 200, { user: store.saveUser(id, fields) }, h);
      }
      return json(res, 200, { user, roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label })) }, h);
    }

    // The people the replica's "signed in as" switcher offers.
    if (url.pathname === '/api/demo-users') {
      return json(res, 200, { users: store.listUsers({ demo: true }).filter((u) => !u.id.startsWith('peer-')).map(({ id, name, role, department, isAdmin }) => ({ id, name, role, department, isAdmin })) }, h);
    }

    if (url.pathname === '/api/welcome') {
      const { user } = currentUser(req);
      if (!user?.role) return json(res, 200, { needsOnboarding: true, user }, h);
      const w = await welcome(store, user, { chunks, facts: retriever.facts });
      for (const c of w.cards) if (c.promoId) store.addEvent({ userId: user.id, type: 'promo_shown', ref: String(c.promoId) });
      return json(res, 200, { user, ...w }, h);
    }

    if (url.pathname === '/api/history' || url.pathname.startsWith('/api/history/')) {
      const { user } = currentUser(req);
      if (!user) return json(res, 200, { conversations: [] }, h);
      const conv = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      if (url.pathname.startsWith('/api/history/') && conv) return json(res, 200, { conversationId: conv, turns: store.conversation(user.id, conv) }, h);
      return json(res, 200, { conversations: store.conversations(user.id, 100) }, h);
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const { user } = currentUser(req);
      const b = await readBody(req, 4000);
      const value = b.value > 0 ? 1 : b.value < 0 ? -1 : b.value === 0 ? null : undefined;
      if (!user || !Number.isInteger(b.turnId) || value === undefined) throw new ChatError('BAD_REQUEST', 'turnId and value required');
      const note = value != null && typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
      const ok = store.setFeedback(b.turnId, user.id, value, note);
      return json(res, ok ? 200 : 404, { ok }, h);
    }

    if (url.pathname === '/api/events' && req.method === 'POST') {
      const { user } = currentUser(req);
      const b = await readBody(req, 8000);
      if (!EVENT_TYPES.has(b.type)) throw new ChatError('BAD_REQUEST', 'unknown event type');
      store.addEvent({ userId: user?.id, type: b.type, turnId: Number.isInteger(b.turnId) ? b.turnId : null, ref: b.ref != null ? String(b.ref).slice(0, 300) : null, data: b.data && typeof b.data === 'object' ? b.data : null });
      return json(res, 200, { ok: true }, h);
    }

    if (url.pathname === '/api/admin/insights') {
      requireAdmin(currentUser(req).user);
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
      const role = ROLES[url.searchParams.get('role')] ? url.searchParams.get('role') : null;
      return json(res, 200, { ...store.insights({ days, role }), roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label })) }, h);
    }

    if (url.pathname === '/api/admin/tests') {
      requireAdmin(currentUser(req).user);
      return json(res, 200, { suites: testStatus() }, h);
    }

    if (url.pathname === '/api/admin/tests/run' && req.method === 'POST') {
      requireAdmin(currentUser(req).user);
      const b = await readBody(req, 1000);
      const r = startRun(String(b.suite || ''));
      if (r.error) throw new ChatError('BAD_REQUEST', r.error);
      return json(res, 202, { run: r.run }, h);
    }

    if (url.pathname === '/api/admin/promotions') {
      const { user } = currentUser(req);
      requireAdmin(user);
      if (req.method === 'POST') {
        const b = await readBody(req, 8000);
        if (!b.title?.trim() || !b.prompt?.trim()) throw new ChatError('BAD_REQUEST', 'title and prompt required');
        const roles = (Array.isArray(b.roles) ? b.roles : []).filter((r) => ROLES[r]);
        const date = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
        const link = String(b.url || '').trim();
        if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new ChatError('BAD_REQUEST', 'The link must start with https://');
        const p = store.savePromotion({
          id: Number.isInteger(b.id) ? b.id : undefined, title: b.title.trim().slice(0, 120), blurb: String(b.blurb || '').slice(0, 400),
          prompt: b.prompt.trim().slice(0, 300), roles, starts: date(b.starts), ends: date(b.ends),
          priority: Number(b.priority) || 0, active: b.active !== false, url: link ? link.slice(0, 1000) : null,
        }, user.id);
        return json(res, 200, { promotion: p }, h);
      }
      return json(res, 200, { promotions: store.listPromotions() }, h);
    }

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      if (serveFile(req, res, resolve(ROOT, 'site/admin'), 'index.html', { 'Cache-Control': 'no-cache' })) return;
    }
    if (url.pathname.startsWith('/admin/')) {
      if (serveFile(req, res, resolve(ROOT, 'site/admin'), url.pathname.slice(7), { 'Cache-Control': 'no-cache' })) return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { id: userKey, user: known } = currentUser(req);
      // Someone who skipped the introduction still gets a history.
      const user = known || (userKey ? store.saveUser(userKey, {}) : null);
      const wait = rateLimited(userKey || req.socket.remoteAddress || 'local');
      if (wait) return json(res, 429, { code: 'RATE_LIMITED', message: `Too many questions — try again in ${wait}s.`, retryAfter: wait }, { ...h, 'Retry-After': String(wait) });
      const body = await readBody(req);
      const messages = parseMessages(body);
      const conversationId = typeof body.conversationId === 'string' && /^[\w-]{4,64}$/.test(body.conversationId) ? body.conversationId : null;

      res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const ctl = new AbortController();
      res.on('close', () => ctl.abort());
      const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      await runChat({ retriever, store }, messages, send, ctl.signal, { user, conversationId });
      res.end();
      return;
    }

    if (url.pathname.startsWith('/lib/')) {
      if (serveFile(req, res, resolve(ROOT, 'extension/lib'), url.pathname.slice(5), { ...h, 'Cache-Control': 'no-cache' })) return;
    }

    if (site && await site.handle(req, res, url, { serveFile })) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    if (err instanceof ChatError) return json(res, err.status, { code: err.code, message: err.message }, h);
    console.error(err);
    if (!res.headersSent) json(res, 500, { code: 'INTERNAL', message: 'Internal error' }, h);
    else res.end();
  }
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`\nSophia ${VERSION}  http://${config.HOST === '127.0.0.1' ? 'localhost' : config.HOST}:${config.PORT}`);
  const p = providers();
  console.log(`  mode: ${!llmAvailable() ? 'retrieval-only (no ANTHROPIC_API_KEY or OPENAI_API_KEY)'
    : p.primary === 'openai' ? `openai (${config.OPENAI_MODEL}; rewrite ${config.OPENAI_QUICK_MODEL})`
    : `claude (${config.ANTHROPIC_MODEL}, effort ${config.ANTHROPIC_EFFORT}; rewrite ${config.REWRITE_MODEL})`}`);
  console.log(`  backup: ${p.backup ? `openai (${config.OPENAI_MODEL}) when Claude can't be reached` : 'none'}`);
  console.log(`  corpus: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.sourceId)).size} sources`);
});
