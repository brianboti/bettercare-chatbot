#!/usr/bin/env node
// Sophia assistant server (answers from the BetterCare site).
//
//   npm start            (node --env-file-if-exists=.env server/index.mjs)
//
//   GET  /api/health     mode, model, corpus size
//   GET  /api/search     hybrid retrieval, no LLM   ?q=...&k=10
//   POST /api/chat       SSE answer stream           { messages: [{role, content}] }
//   GET  /lib/*          shared client modules (extension/lib)
//   GET  /*              the local site replica (site/)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { config } from './config.mjs';
import { ROOT, loadChunks } from './corpus.mjs';
import { buildRetriever } from './retriever.mjs';
import { runChat, parseMessages, sourceView, ChatError } from './chat.mjs';
import { llmAvailable } from './llm.mjs';
import { PROMPT_VERSION } from './prompt.mjs';

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

// ---------------------------------------------------------------- helpers

function cors(req) {
  const o = req.headers.origin || '';
  const ok = o.startsWith('chrome-extension://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)
    || o === 'https://uthealthsa.sharepoint.com';
  return ok ? {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
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

// ---------------------------------------------------------------- routes

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const h = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, h).end(); return; }

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        mode: llmAvailable() ? 'claude' : 'retrieval-only',
        model: llmAvailable() ? config.ANTHROPIC_MODEL : null,
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

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const wait = rateLimited(req.socket.remoteAddress || 'local');
      if (wait) return json(res, 429, { code: 'RATE_LIMITED', message: `Too many questions — try again in ${wait}s.`, retryAfter: wait }, { ...h, 'Retry-After': String(wait) });
      const messages = parseMessages(await readBody(req));

      res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const ctl = new AbortController();
      res.on('close', () => ctl.abort());
      const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      await runChat({ retriever }, messages, send, ctl.signal);
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
  console.log(`\nSophia assistant  http://${config.HOST === '127.0.0.1' ? 'localhost' : config.HOST}:${config.PORT}`);
  console.log(`  mode: ${llmAvailable() ? `claude (${config.ANTHROPIC_MODEL}, effort ${config.ANTHROPIC_EFFORT})` : 'retrieval-only (no ANTHROPIC_API_KEY)'}`);
  console.log(`  corpus: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.sourceId)).size} sources`);
});
