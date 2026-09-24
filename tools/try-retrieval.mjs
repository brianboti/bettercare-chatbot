#!/usr/bin/env node
// Print hybrid retrieval results for ad-hoc queries.
//   node tools/try-retrieval.mjs "how do I use epic on my phone" "another query"
import { loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';

const r = await buildRetriever(loadChunks(), { log: console.error });
for (const q of process.argv.slice(2)) {
  const { results, confidence, lowConfidence } = await r.retrieve(q, { topK: 5 });
  console.log(`\n» ${q}   (confidence ${confidence.toFixed(3)}${lowConfidence ? ', LOW' : ''})`);
  for (const h of results) {
    console.log(`  ${h.cosine?.toFixed(3) ?? '  -  '}  ${h.retrievedBy.join('+').padEnd(14)} ${h.title.slice(0, 70)}  [${h.list}]`);
  }
}
