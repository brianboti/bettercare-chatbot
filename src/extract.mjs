#!/usr/bin/env node
// Turn a raw SharePoint list dump into retrieval chunks.
//
//   node src/extract.mjs <corpus.json> [--out data/chunks.json]
//
// Input  : [{ list, id, items: [...] }]  as produced by the read-only REST fetch
// Output : [{ id, text, title, list, kind, url, links, meta }]
//
// One row = one chunk. List rows are already short and self-contained, so no
// splitting is needed; the largest single row in this corpus is ~2.5 KB.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LISTS } from './lists.config.mjs';
import { htmlToText, normalize, decodeEntities } from './html.mjs';

const SITE = 'https://uthealthsa.sharepoint.com/sites/BetterCare';

// Rows whose text is obviously unfinished authoring, not content.
const PLACEHOLDER = [
  /^desc goes here$/i,
  /^(test|tbd|todo|n\/?a|xxx+)\.?$/i,
  /lorem ipsum|reprehenderit|voluptas|pariatur/i,
  /^answer here\.?$/i,                      // DtlFAQs: every answer is this stub
  /^course\(s\)\??$/i,                       // DtlCrseJR stubs
  /^placeholder\b.*\(test\)$/i,             // Resource Directory test rows
  /^up to 255 characters/i,                 // list-template help text left in rows
];

const isPlaceholder = (s) => !!s && PLACEHOLDER.some((re) => re.test(s.trim()));

// ---- field coercion ---------------------------------------------------
// SharePoint returns the same logical shape several different ways depending on
// column type, so every accessor tolerates all of them.

/** Hyperlink columns come back as { Description, Url }. */
const urlOf = (v) => (v && typeof v === 'object' && v.Url ? v.Url : undefined);

/** Multi-choice columns are arrays; single-choice are bare strings. */
const toArray = (v) => {
  if (v == null || v === '') return undefined;
  const a = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
  return a.length ? a : undefined;
};

/** Lookup columns are sometimes `1` and sometimes `[1]`. */
const toId = (v) => (Array.isArray(v) ? v[0] : v);

/** Yes/No columns are boolean on some lists and the string "True" on others. */
const isFalse = (v) =>
  v === false || (typeof v === 'string' && ['false', 'no', '0'].includes(v.trim().toLowerCase()));

function makeContext(lookups) {
  return {
    // Plain-text columns still arrive HTML-encoded (&#39;), so decode here too.
    // `html()` decodes internally, so text built from it must not pass through
    // this path — that would decode twice.
    text: (v) => (v == null ? '' : normalize(decodeEntities(String(v)))),
    html: (v) => htmlToText(v),
    arr: toArray,
    url: urlOf,
    /** Resolve a lookup id to its category title. */
    lookup: (listName, raw) => {
      const id = toId(raw);
      if (id == null) return undefined;
      return lookups.get(listName)?.get(Number(id));
    },
    /** Collect the hyperlink columns named in `fields`, skipping empties. */
    links: (item, fields) =>
      fields
        .map((f) => item[f])
        .filter((v) => v && typeof v === 'object' && v.Url)
        .map((v) => ({ text: v.Description || v.Url, url: v.Url })),
  };
}

// ---- main -------------------------------------------------------------

export function extract(corpus) {
  const byName = new Map(corpus.map((e) => [e.list, e]));
  const stats = { lists: [], skipped: [], unmapped: [], dropped: {}, droppedRows: [], unpublished: 0 };
  const drop = (why, entry, item, title) => {
    stats.dropped[why] = (stats.dropped[why] || 0) + 1;
    // Duplicates are expected and already cross-referenced on the surviving
    // chunk; everything else dropped should be visible in the report.
    if (why !== 'duplicate') {
      stats.droppedRows.push({ why, list: entry.list, id: item.Id ?? item.ID, title: title ?? item.Title });
    }
  };

  // Pass 1: build id -> title maps for every lookup list.
  const lookups = new Map();
  for (const [name, rule] of Object.entries(LISTS)) {
    if (!rule.lookup) continue;
    const entry = byName.get(name);
    if (!entry) continue;
    lookups.set(name, new Map(entry.items.map((it) => [Number(it.Id ?? it.ID), it.Title])));
  }

  // Pass 2: build chunks.
  const ctx = makeContext(lookups);
  const chunks = [];
  const seen = new Map(); // content hash -> the chunk that claimed it

  for (const entry of corpus) {
    const rule = LISTS[entry.list];
    if (!rule) {
      stats.unmapped.push(entry.list);
      continue;
    }
    if (rule.skip) {
      stats.skipped.push({ list: entry.list, rows: entry.items.length, reason: rule.skip });
      continue;
    }
    if (rule.lookup) continue;

    const build = rule.build ?? LISTS[rule.sameAs]?.build;
    if (!build) throw new Error(`No build() for list "${entry.list}"`);
    const kind = rule.kind ?? LISTS[rule.sameAs]?.kind ?? 'item';

    let kept = 0;
    for (const item of entry.items) {
      // Explicitly inactive rows are retired; a missing flag means the list
      // does not use the column at all.
      if (isFalse(item.IsActive)) { drop('inactive', entry, item); continue; }

      // `published: false` means the row exists but is hidden on the live site
      // (unreleased upgrade content). Kept, flagged, and filtered at retrieval
      // time rather than discarded here — the decision stays reversible.
      const published = rule.published ? rule.published(item) : true;
      if (!published) stats.unpublished++;

      const out = build(item, ctx);
      const title = normalize(decodeEntities(out.title || ''));
      const body = normalize(out.body || '');
      if (!title && !body) { drop('empty', entry, item); continue; }
      if (isPlaceholder(body) || isPlaceholder(title)) { drop('placeholder', entry, item, title || body); continue; }

      const text = title && body && !body.startsWith(title) ? `${title}\n\n${body}` : body || title;
      const itemId = item.Id ?? item.ID;
      const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);

      // The same Q&A is copied into several lists. Keep one chunk and record the
      // other locations on it, so a citation can name every place it appears.
      const existing = seen.get(hash);
      if (existing) {
        (existing.alsoIn ??= []).push(`${entry.list}:${itemId}`);
        drop('duplicate', entry, item);
        continue;
      }

      const chunk = {
        id: `${entry.list}:${itemId}`,
        title,
        text,
        list: entry.list,
        kind,
        url: `${SITE}/_layouts/15/listform.aspx?PageType=4&ListId={${entry.id}}&ID=${itemId}`,
        links: out.links?.length ? out.links : undefined,
        meta: prune({ ...out.meta, published: published ? undefined : false }),
        hash,
      };
      seen.set(hash, chunk);
      chunks.push(chunk);
      kept++;
    }
    stats.lists.push({ list: entry.list, kind, rows: entry.items.length, chunks: kept });
  }

  return { chunks, stats };
}

/** Drop undefined/empty metadata so chunks stay readable. */
function prune(meta) {
  if (!meta) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- CLI --------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();

function cli() {
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--')) ?? 'data/bettercare-corpus.json';
const outIdx = args.indexOf('--out');
const output = outIdx >= 0 ? args[outIdx + 1] : 'data/chunks.json';

const corpus = JSON.parse(readFileSync(resolve(input), 'utf8'));
const { chunks, stats } = extract(corpus);

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), JSON.stringify(chunks, null, 2), 'utf8');

// ---- report -----------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('LIST', 26)} ${pad('KIND', 10)} ROWS -> CHUNKS`);
for (const l of stats.lists.sort((a, b) => b.chunks - a.chunks)) {
  console.log(`${pad(l.list, 26)} ${pad(l.kind, 10)} ${pad(l.rows, 5)} -> ${l.chunks}`);
}
console.log(`\nSkipped lists:`);
for (const s of stats.skipped) console.log(`  ${pad(s.list, 26)} ${pad(s.rows, 5)} ${s.reason}`);
if (stats.unmapped.length) console.log(`\nUnmapped (no rule): ${stats.unmapped.join(', ')}`);
console.log(`\nDropped rows: ${JSON.stringify(stats.dropped)}`);
console.log(`Kept but flagged meta.published=false (hidden on the live site): ${stats.unpublished}`);
if (stats.droppedRows.length) {
  console.log(`
Dropped row detail:`);
  for (const r of stats.droppedRows) console.log(`  [${r.why}] ${r.list}:${r.id} ${JSON.stringify(r.title)}`);
}

const chars = chunks.reduce((n, c) => n + c.text.length, 0);
console.log(
  `\n${chunks.length} chunks, ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens)`,
);
console.log(`median ${median(chunks.map((c) => c.text.length))} chars, max ${Math.max(...chunks.map((c) => c.text.length))}`);
console.log(`wrote ${output}`);

}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
