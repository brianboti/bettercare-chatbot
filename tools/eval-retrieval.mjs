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

const K = 8;
const CASES = [
  ['How do I set up Haiku on my phone?',                         ['Haiku.aspx', 'Haiku Quick Start', 'download and install Epic Haiku']],
  ['How do I use Epic on my phone?',                             ['Haiku']],
  ['What is SlicerDicer called in axiUm?',                       ['Terminology:1']],
  ['Where is the cash drawer tip sheet?',                        ['Cash Drawer']],
  ['Can a resident and an attending both record with Abridge?', ['more than one provider use Abridge']],
  ['What is the Health IT help desk phone number?',              ['text:450-4800', 'Help-Desk-Contact']],
  ['When is the next Epic upgrade?',                             ['Upgrade Timeline', 'Epic-Upgrades.aspx', 'vMay2026', 'vAugust2026', 'Epic Upgrade']],
  ['What training do dental students need?',                    ['DtlCrseJR:2', 'Dental Student']],
  ['How do I pin the Abridge tab in Epic?',                      ['Pin the Abridge', 'Pin-Abridge', 'pin the Abridge tab']],
  ['Which dot phrase gives an Abridge patient visit summary?',   ['FAQsAbridge:13', 'Patient Visit Summary']],
  ['Where is the downtime BCA policy for MSRH?',                 ['BCA Policy', 'BCA.aspx']],
  ['What is Epic Thrive training?',                              ['Thrive']],
  ['Phone number for the Mays Cancer Center lab draw station',   ['MAYS CANCER CENTER']],
  ['How do I cover someone else\'s In Basket?',                   ['Resource Directory:1', 'InBasket Hack', 'attach to an InBasket']],
  ['What is Qualified Health and how do I use Qualified Chat?',  ['QualifiedHealth', 'Qualified Chat', 'Qualified Health']],
  ['Is there an AI governance policy?',                          ['Legislation', 'Policy.aspx', 'Governance', 'Interdisciplinary-Advisory']],
  ['Did UT Health reach Epic Gold Stars level 7?',               ['Level-7', 'Level 7']],
  ['What is Charge Capture Navigator?',                          ['Charge Capture Navigator', 'Charge-Capture-Navigator']],
  ['How do I report an issue or submit a ticket for Epic?',      ['Help-Desk-Contact', 'Report an Issue', 'Submit a', 'Home.aspx', 'technical support']],
  ['What changed with cancer staging in Refuel Phase 4?',        ['Cancer Staging']],
  ['What devices can run Epic Haiku?',                           ['compatible with Epic Haiku', 'Haiku.aspx', 'Compatible Devices']],
  ['What happened at the Kyle Seale Parkway opening?',           ['Kyle-Seale-Parkway']],
  ['How do I get access to Abridge?',                            ['AbridgeInside', 'How do I get started', 'Abridge', 'access Abridge']],
  ['Where can I find Abridge office hours?',                     ['text:office hours']],
  ['What AI tools are approved for use?',                        ['Approved Gen AI', 'Approved-Gen', 'AITools']],
  // Time-relative and role-filtered upgrade questions ("last" = most recent
  // go-live before today, per the Upgrade Timeline list).
  ['What should a surgeon know about what is new in Epic with the last upgrade?', ['text:Surgical Scheduling']],
  ['What changed for anesthesia in the latest upgrade?',        ['text:preprocedure evaluation']],
  ['What is coming in the next Epic upgrade?',                   ['text:vMay2026', 'text:vMay26']],
  ['When did the last upgrade go live?',                         ['Upgrade Timeline:8']],
  ['What was new in the previous upgrade?',                      ['vNovember2025', 'vNov25', 'text:vNovember2025']],
  ['how do I file my taxes',                                     null],
  ['best pizza delivery near me',                                null],
  ['What is the weather in Austin tomorrow?',                    null],
  ['How do I renew my driver license?',                          null],
  ['Recommend a good sci-fi novel',                              null],
];

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
