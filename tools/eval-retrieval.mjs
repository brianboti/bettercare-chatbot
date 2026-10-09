#!/usr/bin/env node
// Retrieval eval: recall@k and MRR over a fixed question set. No LLM — fast,
// free, deterministic. Run after any change to ingestion, chunking,
// embeddings or ranking:
//
//   npm run eval                 all questions
//   npm run eval -- --verbose    show the top results for every question
//
// Recall is measured at the depth the chat actually uses: top 8, or top 16
// for broad questions (see isBroad in server/chat.mjs).
//
// Each case lists substrings; a result matches if its id or title contains
// any of them (case-insensitive), or for "text:..." if its text does. `null` means the question is off-topic and
// should come back low-confidence.

import { loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';
import { isBroad } from '../server/chat.mjs';
import { config } from '../server/config.mjs';
import { RETRIEVAL_CASES as CASES } from './eval-cases.mjs';

const K = 8;

const verbose = process.argv.includes('--verbose');
const found = [], flagged = []; // for --json (the admin panel's Tests tab)
const retriever = await buildRetriever(loadChunks(), { log: console.error });

let hits = 0, rr = 0, answerable = 0, offOk = 0, off = 0;
const confs = [];
for (const [q, expect] of CASES) {
  // Same settings the chat uses: broad questions get more, deeper context.
  const broad = isBroad(q);
  const { results, confidence, lowConfidence } = await retriever.retrieve(q, broad
    ? { topK: config.BROAD_TOP_K, maxPerSource: config.BROAD_MAX_PER_SOURCE }
    : { topK: K });
  if (expect === null) {
    off++;
    if (lowConfidence) offOk++;
    flagged.push({ name: q, pass: lowConfidence, detail: `${lowConfidence ? 'Flagged as unrelated' : 'Not flagged: looked like a match'} (match ${confidence.toFixed(2)})` });
    console.log(`${lowConfidence ? 'PASS' : 'FAIL'}  (off-topic, confidence ${confidence.toFixed(3)})  ${q}`);
    continue;
  }
  answerable++;
  const matches = (r, e) => (e.startsWith('text:')
    ? r.text.toLowerCase().includes(e.slice(5).toLowerCase())
    : `${r.id} ${r.title}`.toLowerCase().includes(e.toLowerCase()));
  const rank = results.findIndex((r) => expect.some((e) => matches(r, e)));
  confs.push(confidence);
  if (rank >= 0) { hits++; rr += 1 / (rank + 1); }
  found.push({ name: q, pass: rank >= 0, detail: rank >= 0 ? `Right source at #${rank + 1} of ${broad ? config.BROAD_TOP_K : K} (match ${confidence.toFixed(2)})` : `Right source not in the top ${broad ? config.BROAD_TOP_K : K}: got ${results[0]?.title || 'nothing'}`, expected: expect.join(' or ') });
  console.log(`${rank >= 0 ? 'PASS' : 'FAIL'}  rank ${rank >= 0 ? rank + 1 : '-'}${broad ? `/${config.BROAD_TOP_K}` : ''}  (confidence ${confidence.toFixed(3)})  ${q}`);
  if (verbose || rank < 0) {
    results.slice(0, 5).forEach((r, i) => console.log(`        ${i + 1}. ${r.title.slice(0, 70)}  [${r.id.slice(0, 60)}] ${r.retrievedBy.join('+')}`));
  }
}

console.log(`\nlowest answerable confidence: ${Math.min(...confs).toFixed(3)}`);
console.log(`recall@${K}: ${(hits / answerable).toFixed(3)} (${hits}/${answerable})   MRR: ${(rr / answerable).toFixed(3)}   off-topic flagged: ${offOk}/${off}`);
if (hits / answerable < 0.8) process.exitCode = 1;

if (process.argv.includes('--json')) {
  console.log(`@@RESULT ${JSON.stringify({
    metrics: [
      { label: 'Found the right source', value: `${hits} of ${answerable}` },
      { label: 'Average rank score (MRR)', value: (rr / answerable).toFixed(2) },
      { label: 'Unrelated questions flagged', value: `${offOk} of ${off}` },
    ],
    groups: [
      { name: 'Finds the right page or document', description: `For each question, the page or file that answers it must be in the top ${K} search results (top ${config.BROAD_TOP_K} for broad questions). No AI model is involved.`, cases: found },
      { name: 'Flags unrelated questions', description: 'Questions that have nothing to do with BetterCare must come back as a weak match, so Sophia knows not to answer them.', cases: flagged },
    ],
  })}`);
}
