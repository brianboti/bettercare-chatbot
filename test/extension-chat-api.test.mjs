// Covers: The client library shared by the Chrome extension and the site (extension/lib/chat-api.js): who-is-asking headers, JSON calls, search, reading the answer stream, and splitting out [n] citations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { health, userHeaders, apiJson, searchApi, streamChat, splitCitations } from '../extension/lib/chat-api.js';

// A tiny stand-in server: each path answers the way a test needs.
const seen = [];
let api;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ method: req.method, url: req.url, headers: req.headers, body });
  const sse = (chunks, { end = true, delay = 0 } = {}) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    (async () => {
      for (const c of chunks) { res.write(c); if (delay) await new Promise((r) => setTimeout(r, delay)); }
      if (end) res.end();
    })();
  };
  switch (req.url.split('?')[0]) {
    case '/api/health': return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"version":"9.9.9"}');
    case '/slow/api/health': return setTimeout(() => res.writeHead(200).end('{}'), 500);
    case '/down/api/health': return res.writeHead(503).end('{}');
    case '/api/thing': return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ echo: body ? JSON.parse(body) : null }));
    case '/api/fail': return res.writeHead(500).end('{"code":"INTERNAL"}');
    case '/api/search': return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"results":[]}');
    case '/bad/api/search': return res.writeHead(500).end('nope');
    case '/api/chat': return sse([
      'event: status\ndata: {"stage":"retrieving"}\n\n',
      'event: sources\ndata: [{"n":1,"title":"A"}]\n\nevent: tok',   // an event split across chunks
      'en\ndata: {"text":"Hel"}\n\n',
      ': a comment line, ignored\n\n',
      'event: token\ndata: {not json}\n\n',                       // malformed: skipped
      'event: token\ndata: {"text":"lo [1]"}\n\n',
      'event: done\ndata: {"mode":"retrieval-only","turnId":7}\n\n',
    ]);
    case '/cut/api/chat': return sse(['event: token\ndata: {"text":"partial"}\n\n']);
    case '/err/api/chat': return sse(['event: error\ndata: {"code":"UPSTREAM_LLM","message":"x"}\n\n']);
    case '/429/api/chat': return res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"code":"RATE_LIMITED","message":"Too many questions","retryAfter":30}');
    case '/html/api/chat': return res.writeHead(502, { 'Content-Type': 'text/html' }).end('<h1>Bad gateway</h1>');
    case '/hang/api/chat': return sse(['event: token\ndata: {"text":"..."}\n\n'], { end: false });
    default: return res.writeHead(404).end();
  }
});

before(() => new Promise((ok) => server.listen(0, '127.0.0.1', () => { api = `http://127.0.0.1:${server.address().port}`; ok(); })));
after(() => { server.closeAllConnections(); return new Promise((ok) => server.close(ok)); });
const last = () => seen[seen.length - 1];

/** Run streamChat and record every handler call in order. */
async function stream(base, opts = {}, signal) {
  const calls = [];
  const on = new Proxy({}, { get: (_, ev) => (data) => calls.push([ev, data]) });
  await streamChat(base, [{ role: 'user', content: 'hi' }], on, signal, opts);
  return calls;
}

test('userHeaders: the header only when someone is signed in', () => {
  assert.deepEqual(userHeaders('pat.lee'), { 'X-Sophia-User': 'pat.lee' });
  assert.deepEqual(userHeaders(''), {});
  assert.deepEqual(userHeaders(undefined), {});
});

test('health: the server\'s answer, or null when it is down, failing or too slow', async () => {
  assert.deepEqual(await health(api), { ok: true, version: '9.9.9' });
  assert.equal(await health(`${api}/down`), null);
  assert.equal(await health(`${api}/slow`, { timeoutMs: 50 }), null);
  assert.equal(await health('http://127.0.0.1:1'), null);
});

test('apiJson: GET with the user header; POST with a JSON body; null on any failure', async () => {
  assert.deepEqual(await apiJson(api, '/api/thing', { userId: 'ann' }), { echo: null });
  assert.equal(last().method, 'GET');
  assert.equal(last().headers['x-sophia-user'], 'ann');
  assert.equal(last().headers['content-type'], undefined);

  assert.deepEqual(await apiJson(api, '/api/thing', { body: { a: 1 } }), { echo: { a: 1 } });
  assert.equal(last().method, 'POST');
  assert.equal(last().headers['content-type'], 'application/json');
  assert.equal(last().headers['x-sophia-user'], undefined);

  await apiJson(api, '/api/thing', { method: 'DELETE' });
  assert.equal(last().method, 'DELETE');

  assert.equal(await apiJson(api, '/api/fail'), null);
  assert.equal(await apiJson('http://127.0.0.1:1', '/api/thing'), null);
});

test('searchApi: encodes the query and k; throws on a server error', async () => {
  assert.deepEqual(await searchApi(api, 'tip sheets & more?', 3), { results: [] });
  assert.equal(last().url, '/api/search?q=tip%20sheets%20%26%20more%3F&k=3');
  await searchApi(api, 'x');
  assert.match(last().url, /&k=10$/, 'k defaults to 10');
  await assert.rejects(searchApi(`${api}/bad`, 'x'), /search failed: 500/);
});

test('streamChat: events in order, split chunks joined, comments and malformed data skipped', async () => {
  const calls = await stream(api, { userId: 'ann', conversationId: 'conv-1' });
  assert.deepEqual(calls, [
    ['status', { stage: 'retrieving' }],
    ['sources', [{ n: 1, title: 'A' }]],
    ['token', { text: 'Hel' }],
    ['token', { text: 'lo [1]' }],
    ['done', { mode: 'retrieval-only', turnId: 7 }],
  ]);
  const req = last();
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.accept, 'text/event-stream');
  assert.equal(req.headers['x-sophia-user'], 'ann');
  assert.deepEqual(JSON.parse(req.body), { messages: [{ role: 'user', content: 'hi' }], conversationId: 'conv-1' });
});

test('streamChat: a stream that ends without done reports an error instead of hanging', async () => {
  const calls = await stream(`${api}/cut`);
  assert.deepEqual(calls.at(-1), ['error', { code: 'INTERNAL', message: 'The connection closed before the answer finished.' }]);
  assert.equal(calls.filter(([e]) => e === 'error').length, 1);
});

test('streamChat: a server error event is passed on once, with no extra error', async () => {
  assert.deepEqual(await stream(`${api}/err`), [['error', { code: 'UPSTREAM_LLM', message: 'x' }]]);
});

test('streamChat: HTTP errors become one error event (JSON body kept, otherwise the status)', async () => {
  assert.deepEqual(await stream(`${api}/429`), [['error', { code: 'RATE_LIMITED', message: 'Too many questions', retryAfter: 30 }]]);
  assert.deepEqual(await stream(`${api}/html`), [['error', { code: 'INTERNAL', message: 'Server returned 502.' }]]);
});

test('streamChat: an unreachable server is reported as UNREACHABLE', async () => {
  const calls = await stream('http://127.0.0.1:1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].code, 'UNREACHABLE');
  assert.match(calls[0][1].message, /127\.0\.0\.1:1/);
});

test('streamChat: aborting stops quietly, before or during the stream', async () => {
  assert.deepEqual(await stream(api, {}, AbortSignal.abort()), [], 'aborted before the request: nothing reported');
  const ctl = new AbortController();
  const done = stream(`${api}/hang`, {}, ctl.signal);
  setTimeout(() => ctl.abort(), 100);
  const calls = await done;
  assert.deepEqual(calls, [['token', { text: '...' }]], 'aborted mid-stream: no error added');
});

test('splitCitations: text and citation markers, including lists of numbers', () => {
  assert.deepEqual(splitCitations('Open Haiku [2].'), [{ text: 'Open Haiku ' }, { cite: 2 }, { text: '.' }]);
  assert.deepEqual(splitCitations('Both [1, 3]'), [{ text: 'Both ' }, { cite: 1 }, { cite: 3 }]);
  assert.deepEqual(splitCitations('[4][5]'), [{ cite: 4 }, { cite: 5 }]);
  assert.deepEqual(splitCitations('No citations here'), [{ text: 'No citations here' }]);
  assert.deepEqual(splitCitations(''), []);
  assert.deepEqual(splitCitations('Not citations: [a] [1a] [ 2 ]'), [{ text: 'Not citations: [a] [1a] [ 2 ]' }]);
});
