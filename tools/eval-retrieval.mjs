#!/usr/bin/env node
// Retrieval eval: recall@k and MRR over a fixed question set. No LLM — fast,
// free, deterministic. Run after any change to ingestion, chunking,
// embeddings or ranking:
//
//   npm run eval                 all questions
//   npm run eval -- --verbose    show the top results for every question
//
// Each case lists substrings; a result matches if its id or title contains
// any of them (case-insensitive), or for "text:..." if its text does. `null` means the question is off-topic and
// should come back low-confidence.

import { loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';

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
  ['how do I file my taxes',                                     null],
  ['best pizza delivery near me',                                null],
  ['What is the weather in Austin tomorrow?',                    null],
  ['How do I renew my driver license?',                          null],
  ['Recommend a good sci-fi novel',                              null],
];

const verbose = process.argv.includes('--verbose');
const retriever = await buildRetriever(loadChunks(), { log: console.error });

let hits = 0, rr = 0, answerable = 0, offOk = 0, off = 0;
const confs = [];
for (const [q, expect] of CASES) {
  const { results, confidence, lowConfidence } = await retriever.retrieve(q, { topK: K });
  if (expect === null) {
    off++;
    if (lowConfidence) offOk++;
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
  console.log(`${rank >= 0 ? 'PASS' : 'FAIL'}  rank ${rank >= 0 ? rank + 1 : '-'}  (confidence ${confidence.toFixed(3)})  ${q}`);
  if (verbose || rank < 0) {
    results.slice(0, 5).forEach((r, i) => console.log(`        ${i + 1}. ${r.title.slice(0, 70)}  [${r.id.slice(0, 60)}] ${r.retrievedBy.join('+')}`));
  }
}

console.log(`\nlowest answerable confidence: ${Math.min(...confs).toFixed(3)}`);
console.log(`recall@${K}: ${(hits / answerable).toFixed(3)} (${hits}/${answerable})   MRR: ${(rr / answerable).toFixed(3)}   off-topic flagged: ${offOk}/${off}`);
if (hits / answerable < 0.8) process.exitCode = 1;
