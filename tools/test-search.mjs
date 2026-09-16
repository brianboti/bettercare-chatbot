#!/usr/bin/env node
// Exercise the panel's ranking without a browser.
//
//   node tools/test-search.mjs              run the fixed set of checks
//   node tools/test-search.mjs "a question" try one query

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, search } from '../extension/search.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(resolve(ROOT, 'extension/data/corpus.json'), 'utf8'));
const index = buildIndex(corpus);

// Each case: the query, and a substring the top hit's title must contain.
// `null` means the query should return nothing rather than a bad citation.
const CASES = [
  ['What is Epic Haiku?',                        'Haiku'],
  ['What is SlicerDicer called in axiUm?',        'SlicerDicer'],
  ['Find the cash drawer tip sheet',              'Cash Drawer'],
  ['What is Abridge Dictation?',                  'Abridge'],
  ['When did the vAugust2024 upgrade go live?',   'vAugust2024'],
  ['in basket',                                   'In Basket'],
  ['what training do dental students need',       'Dental'],
  ['how do I file my taxes',                      null],
  ['pizza delivery',                              null],
];

const one = process.argv[2];

if (one) {
  report(one, search(index, one));
} else {
  let pass = 0;
  for (const [q, expect] of CASES) {
    const hits = search(index, q);
    const top = hits[0]?.chunk;
    const ok = expect === null
      ? hits.length === 0
      : !!top && top.t.toLowerCase().includes(expect.toLowerCase());

    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}`);
    if (!ok || process.env.VERBOSE) {
      console.log(`        expected: ${expect ?? '(no result)'}`);
      console.log(`        got:      ${top ? `${top.t}  [${top.k}/${top.l}]` : '(no result)'}`);
    }
  }
  console.log(`\n${pass}/${CASES.length} passed`);
  if (pass !== CASES.length) process.exitCode = 1;
}

function report(q, hits) {
  console.log(`\nQuery: ${q}\n`);
  if (!hits.length) return console.log('  (nothing matched — panel would say "not on this site")');
  hits.forEach((h, i) => {
    console.log(`  ${i + 1}. [${h.score.toFixed(2)}] ${h.chunk.t}`);
    console.log(`     ${h.chunk.k} · ${h.chunk.l}`);
    console.log(`     ${h.chunk.x.replace(/\n+/g, ' ').slice(0, 150)}\n`);
  });
}
