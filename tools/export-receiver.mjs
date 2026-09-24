#!/usr/bin/env node
// Receives the site export streamed from a signed-in browser tab.
//
// SharePoint auth cookies are HttpOnly, so node can't fetch the site itself
// without an app registration. Instead tools/export-site.browser.js runs in a
// signed-in tab, GETs everything read-only, and PUTs each file here. This
// server only writes under data/site/ and only accepts the SharePoint origin.
//
//   node tools/export-receiver.mjs            (listens on 127.0.0.1:8799)

import { createServer } from 'node:http';
import { mkdirSync, createWriteStream, statSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/site');
const ORIGIN = 'https://uthealthsa.sharepoint.com';
const PORT = Number(process.env.PORT || 8799);

mkdirSync(OUT, { recursive: true });
let files = 0, bytes = 0;

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Path',
  // Chrome's Private/Local Network Access preflight for public site -> localhost.
  'Access-Control-Allow-Private-Network': 'true',
};

/** Map an export path to a file under data/site, refusing traversal. */
function target(p) {
  // Already decoded by URLSearchParams — decoding again would turn a literal
  // "%20" in a SharePoint file name into a space.
  const clean = String(p).replace(/^\/+/, '').replace(/\\/g, '/');
  const full = resolve(OUT, clean);
  if (!full.startsWith(OUT + sep)) throw new Error(`refused path: ${p}`);
  return full;
}

createServer((req, res) => {
  if (req.headers.origin && req.headers.origin !== ORIGIN) { res.writeHead(403).end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }

  const url = new URL(req.url, 'http://x');

  // Serves the exporter itself, so it can be loaded into the tab with one line:
  //   eval(await (await fetch('http://127.0.0.1:8799/exporter.js')).text())
  if (req.method === 'GET' && url.pathname === '/exporter.js') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript' })
      .end(readFileSync(resolve(ROOT, 'tools/export-site.browser.js')));
    return;
  }

  // Lets the exporter skip files already received (resumable).
  if (req.method === 'GET' && url.pathname === '/has') {
    let size = -1, marker = false;
    try {
      const file = target(url.searchParams.get('path'));
      size = statSync(file).size;
      // ?marker=... asks whether the file contains a string (e.g. a snapshot format version).
      const m = url.searchParams.get('marker');
      if (m) marker = readFileSync(file, 'utf8').includes(m);
    } catch { /* missing */ }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ size, marker }));
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/put') {
    let file;
    try { file = target(url.searchParams.get('path')); } catch (e) { res.writeHead(400, cors).end(String(e)); return; }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.part`;
    const ws = createWriteStream(tmp);
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.pipe(ws);
    ws.on('finish', async () => {
      const { renameSync } = await import('node:fs');
      renameSync(tmp, file);
      files++; bytes += n;
      if (files % 50 === 0) console.log(`${files} files, ${(bytes / 1e6).toFixed(0)} MB`);
      res.writeHead(200, cors).end('ok');
    });
    ws.on('error', (e) => { res.writeHead(500, cors).end(String(e)); });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/log') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      appendFileSync(resolve(OUT, 'export-log.txt'), `${body}\n`);
      console.log(body);
      res.writeHead(200, cors).end('ok');
    });
    return;
  }

  res.writeHead(404, cors).end();
}).listen(PORT, '127.0.0.1', () => console.log(`export receiver on http://127.0.0.1:${PORT} -> ${OUT}`));
