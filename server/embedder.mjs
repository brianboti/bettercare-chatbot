// Local sentence embeddings (transformers.js / ONNX, runs on CPU in-process).
//
// No API key and no network after the model's first download (~35 MB, cached
// by transformers.js). Swapping to a hosted embedder (Voyage, Azure OpenAI)
// means replacing this module; `modelId` keys the vector cache so a swap
// forces a re-embed instead of silently mixing vector spaces.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { ROOT } from './corpus.mjs';

const CACHE = resolve(ROOT, 'data/embeddings.json');

let extractor = null;

async function model() {
  if (!extractor) {
    const { pipeline } = await import('@huggingface/transformers');
    extractor = await pipeline('feature-extraction', config.EMBEDDING_MODEL, { dtype: 'q8' });
  }
  return extractor;
}

/** Embed texts → unit-length Float32Arrays. */
export async function embed(texts, { batch = 32 } = {}) {
  const fe = await model();
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await fe(texts.slice(i, i + batch), { pooling: 'cls', normalize: true });
    for (const row of t.tolist()) out.push(Float32Array.from(row));
  }
  return out;
}

export const embedQuery = async (q) => (await embed([config.EMBEDDING_QUERY_PREFIX + q]))[0];

const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Vectors for every chunk, reusing the on-disk cache where the model and the
 * indexed text are unchanged. Returns Map<id, Float32Array>.
 * `cacheFile` and `embedTexts` default to the real cache and model (tests swap them).
 */
export async function embedChunks(chunks, { log = () => {}, cacheFile = CACHE, embedTexts = embed } = {}) {
  let cache = { model: null, items: {} };
  if (existsSync(cacheFile)) {
    try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* rebuild */ }
  }
  if (cache.model !== config.EMBEDDING_MODEL) cache = { model: config.EMBEDDING_MODEL, items: {} };

  const todo = chunks.filter((c) => cache.items[c.id]?.h !== hashOf(c.indexText));
  if (todo.length) {
    log(`embedding ${todo.length} of ${chunks.length} chunks with ${config.EMBEDDING_MODEL}…`);
    const vecs = await embedTexts(todo.map((c) => c.indexText));
    todo.forEach((c, i) => {
      cache.items[c.id] = { h: hashOf(c.indexText), v: Array.from(vecs[i], (x) => +x.toFixed(5)) };
    });
  }

  // Drop vectors for chunks that no longer exist, so deletions propagate.
  const live = new Set(chunks.map((c) => c.id));
  let pruned = 0;
  for (const id of Object.keys(cache.items)) if (!live.has(id)) { delete cache.items[id]; pruned++; }

  if (todo.length || pruned) writeFileSync(cacheFile, JSON.stringify(cache));

  return new Map(chunks.map((c) => [c.id, Float32Array.from(cache.items[c.id].v)]));
}
