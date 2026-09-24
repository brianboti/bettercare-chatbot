#!/usr/bin/env node
// Make image-only content searchable: transcribe flyers, screenshots and
// scanned PDFs with Claude, so "find the Abridge office hours flyer" can match
// the words printed on it, not just its file name.
//
//   node --env-file=.env tools/ocr-with-claude.mjs            (only new files)
//   node --env-file=.env tools/ocr-with-claude.mjs --dry-run  (list + estimate)
//
// Results are cached in data/index/ocr.json keyed by path|size, and picked up
// by src/ingest/documents.mjs on the next `npm run ingest`.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(ROOT, 'data/site');
const OUT = resolve(ROOT, 'data/index/ocr.json');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const dry = process.argv.includes('--dry-run');

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE = 5 * 1024 * 1024;         // API limit per image
const MAX_PDF = 30 * 1024 * 1024;
const LIBRARIES = new Set(['Documents', 'Images', 'Refuel/Upgrade']);   // Site Assets images are page decoration

const PROMPT = `This file is from the BetterCare SharePoint site (UT Health San Antonio Clinical IT). Transcribe it so it can be found by search.

Output:
1. One sentence saying what it is (e.g. "Flyer announcing Abridge virtual office hours.").
2. All readable text, in reading order, preserving headings, dates, times, phone numbers, URLs and names of systems. Use "- " for list items.

If there is no meaningful text, give only the one-sentence description. Do not add commentary.`;

const manifest = JSON.parse(readFileSync(resolve(SITE, 'files.json'), 'utf8'));
const report = existsSync(resolve(ROOT, 'data/index/report.json')) ? JSON.parse(readFileSync(resolve(ROOT, 'data/index/report.json'), 'utf8')) : null;
const scanned = new Set(report?.documents?.noText || []);
const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const todo = [];
for (const f of manifest) {
  const rel = f.path.replace(/^\/sites\/BetterCare\//, '');
  const local = resolve(SITE, 'files', rel);
  const ext = extname(f.name).slice(1).toLowerCase();
  const key = `${f.path}|${f.size}`;
  if (cache[key] || !existsSync(local)) continue;
  const size = statSync(local).size;
  if (IMAGE_TYPES[ext] && LIBRARIES.has(f.library) && size <= MAX_IMAGE && size > 2000) todo.push({ f, local, key, kind: 'image', media: IMAGE_TYPES[ext] });
  else if (ext === 'pdf' && scanned.has(rel) && size <= MAX_PDF) todo.push({ f, local, key, kind: 'pdf' });
}

console.log(`${todo.length} files to transcribe (${todo.filter((t) => t.kind === 'image').length} images, ${todo.filter((t) => t.kind === 'pdf').length} scanned PDFs); ${Object.keys(cache).length} already cached`);
if (dry || !todo.length) process.exit(0);

const client = new Anthropic();
let done = 0, failed = 0;

async function one(t) {
  const data = readFileSync(t.local).toString('base64');
  const block = t.kind === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: t.media, data } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
  });
  if (res.stop_reason === 'refusal') throw new Error('refused');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  cache[t.key] = { text, model: res.model, at: new Date().toISOString() };
}

let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < todo.length) {
    const t = todo[i++];
    try { await one(t); done++; } catch (e) { failed++; console.warn(`  failed ${t.f.name}: ${e.message}`); }
    if ((done + failed) % 10 === 0) {
      writeFileSync(OUT, JSON.stringify(cache, null, 1));
      console.log(`  ${done + failed}/${todo.length}`);
    }
  }
}));
writeFileSync(OUT, JSON.stringify(cache, null, 1));
console.log(`transcribed ${done}, failed ${failed} -> data/index/ocr.json. Run npm run ingest to index them.`);
