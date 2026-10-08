#!/usr/bin/env node
// Build the search corpus from the full site export.
//
//   node src/ingest/index.mjs            -> data/index/chunks.json + report.json
//
// Sources (all under data/site/, produced by tools/export-site.browser.js):
//   lists/*.json      list rows       -> src/extract.mjs + src/lists.config.mjs
//   pages/*.json      Site Pages      -> src/ingest/pages.mjs
//   snapshots/*.html  rendered pages  -> src/ingest/pages.mjs
//   files.json+files/ documents       -> src/ingest/documents.mjs
//
// Every chunk has the same shape, whatever it came from:
//   { id, sourceId, sourceType: 'list-item'|'page'|'document', kind, title,
//     headingPath[], text, url, localUrl, list, links?, meta, hash }

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../extract.mjs';
import { ingestPages } from './pages.mjs';
import { ingestDocuments } from './documents.mjs';
import { testMarker, placeholderText } from './test-content.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_DIR = resolve(ROOT, 'data/site');
const OUT_DIR = resolve(ROOT, 'data/index');

const log = (...a) => console.log(...a);

// The site footer shows on every page but isn't part of any page's content
// (or the export), so it's indexed from what the live site displays.
const SITE_FOOTER = {
  id: 'site:footer',
  sourceId: 'site:footer',
  sourceType: 'page',
  kind: 'page',
  title: 'BetterCare site footer — help desk contacts',
  headingPath: [],
  text: [
    'Shown at the bottom of every BetterCare page:',
    '- Epic IT Help Desk: (210) 450-4800 or 210-450-HELP',
    '- Email: HealthITSupport@uthscsa.edu',
    '- Report issues on this site to BetterCare@uthscsa.edu',
    '- Links: BetterCare Homepage, UT Health Connect',
  ].join('\n'),
  url: 'https://uthealthsa.sharepoint.com/sites/BetterCare',
  localUrl: '/sites/BetterCare/SitePages/Home.aspx',
  list: 'Site Pages',
  meta: {},
};

function ingestLists() {
  const dir = resolve(SITE_DIR, 'lists');
  const corpus = readdirSync(dir).map((f) => {
    const l = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    return { list: l.list, id: l.id, items: l.items };
  });
  const { chunks, stats } = extract(corpus);
  const testRows = [];
  const out = chunks
    // Hidden on the live site (e.g. unreleased upgrade content).
    .filter((c) => c.meta?.published !== false)
    // Rows the site admin added to try something out ("Test", "test event").
    .filter((c) => {
      const why = testMarker(c.title) ? `"${c.title}"` : placeholderText(c.text.replace(c.title, '')) ? 'placeholder text' : null;
      if (why) testRows.push(`${c.list}: ${why}`);
      return !why;
    })
    .map((c) => ({
      id: `list:${c.id}`,
      sourceId: `list:${c.id}`,
      sourceType: 'list-item',
      kind: c.kind,
      title: c.title,
      headingPath: [c.meta?.category].filter(Boolean),
      text: c.text,
      url: c.url,
      localUrl: null,               // filled in below from the page that displays it
      list: c.list,
      links: c.links,
      meta: c.meta,
      alsoIn: c.alsoIn,
      hash: c.hash,
    }));
  return { chunks: out, report: { lists: stats.lists, testRows, skipped: stats.skipped.map((s) => `${s.list}: ${s.reason}`), unmapped: stats.unmapped, dropped: stats.dropped, droppedRows: stats.droppedRows } };
}

/**
 * List rows are displayed by web parts on pages. Point each row at the page
 * that shows it (found by its title appearing in that page's text), so a
 * citation opens where a user would actually see it.
 */
function linkListRowsToPages(listChunks, pageChunks) {
  const pageText = new Map();
  for (const c of pageChunks) {
    pageText.set(c.sourceId, `${pageText.get(c.sourceId) || ''}\n${c.text.toLowerCase()}`);
  }
  const pageMeta = new Map(pageChunks.map((c) => [c.sourceId, c]));
  let linked = 0;
  for (const c of listChunks) {
    const needle = c.title.toLowerCase().trim();
    if (needle.length < 8) continue;
    // Prefer non-news pages; among those, the first match.
    let best = null;
    for (const [sid, text] of pageText) {
      if (!text.includes(needle)) continue;
      const p = pageMeta.get(sid);
      if (!best || (best.kind === 'news' && p.kind !== 'news')) best = p;
    }
    if (best) {
      c.localUrl = best.localUrl;
      c.meta = { ...(c.meta || {}), shownOn: best.title, shownOnUrl: best.url };
      linked++;
    }
  }
  return linked;
}

async function main() {
  const t0 = Date.now();
  mkdirSync(OUT_DIR, { recursive: true });

  log('lists…');
  const lists = ingestLists();
  log(`  ${lists.chunks.length} chunks`);

  log('pages…');
  const pages = ingestPages(SITE_DIR);
  log(`  ${pages.report.pages} pages (${pages.report.withSnapshot} with snapshots), ${pages.report.excluded.length} excluded -> ${pages.chunks.length} chunks`);

  log('documents…');
  const docs = await ingestDocuments(SITE_DIR, { cacheFile: resolve(OUT_DIR, 'extract-cache.json'), ocrFile: resolve(OUT_DIR, 'ocr.json'), log });
  log(`  ${docs.report.extracted} extracted, ${docs.report.cataloged} cataloged by name, ${docs.report.duplicates} duplicate copies, ${docs.report.failed.length} failed, ${docs.report.missing.length} missing -> ${docs.chunks.length} chunks`);

  const linked = linkListRowsToPages(lists.chunks, pages.chunks);
  log(`  ${linked}/${lists.chunks.length} list rows linked to the page that displays them`);

  const chunks = [...pages.chunks, SITE_FOOTER, ...lists.chunks, ...docs.chunks];

  // Chunk ids must be unique — they key the embedding cache and citations.
  const seen = new Set();
  for (const c of chunks) {
    if (seen.has(c.id)) throw new Error(`duplicate chunk id ${c.id}`);
    seen.add(c.id);
  }

  writeFileSync(resolve(OUT_DIR, 'chunks.json'), JSON.stringify(chunks));
  const report = {
    builtAt: new Date().toISOString(),
    chunks: chunks.length,
    bySourceType: count(chunks, 'sourceType'),
    byKind: count(chunks, 'kind'),
    approxTokens: Math.round(chunks.reduce((n, c) => n + c.text.length, 0) / 4),
    lists: lists.report,
    pages: pages.report,
    documents: docs.report,
  };
  writeFileSync(resolve(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(`\n${chunks.length} chunks (~${report.approxTokens.toLocaleString()} tokens) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(JSON.stringify(report.byKind));
  const testOut = [
    ...pages.report.excluded.filter((e) => e.why.startsWith('test page')).map((e) => `page      ${e.page}`),
    ...docs.report.testContent.map((d) => `document  ${d}`),
    ...lists.report.testRows.map((r) => `list row  ${r}`),
  ];
  log(`\nLeft out as test content (${testOut.length}):${testOut.map((t) => `\n  ${t}`).join('')}`);
  if (docs.report.noText.length) log(`${docs.report.noText.length} PDFs look scanned (little or no text layer) — see report.json`);
  log(`wrote data/index/chunks.json, data/index/report.json`);
}

function count(arr, key) {
  const m = {};
  for (const x of arr) m[x[key]] = (m[x[key]] || 0) + 1;
  return m;
}

main().catch((e) => { console.error(e); process.exit(1); });
