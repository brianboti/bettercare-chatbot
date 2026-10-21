#!/usr/bin/env node
// Prepares the search index so the server starts fast.
//
//   npm run build:index              chunks → vectors (downloads the embedding model once)
//   npm run build:index -- --ingest  first rebuild the chunks from the site export
//
// 1. The chunks (CHUNKS_FILE, data/index/chunks.json) are committed to the
//    repository. --ingest rebuilds them from the site export (SITE_DIR), which
//    only someone with the export can do (see README, "Data").
// 2. The vectors (EMBEDDINGS_FILE, data/embeddings.json) are computed here
//    from the chunks with the local embedding model, which is downloaded to
//    MODEL_CACHE_DIR (or the library's default) the first time. The server
//    reuses them and only embeds chunks that changed, so with this done it
//    starts in seconds instead of minutes.
//
// The Docker build runs this, so the image carries the model and the vectors.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const t0 = Date.now();

if (process.argv.includes('--ingest')) {
  if (!existsSync(resolve(config.SITE_DIR, 'pages'))) {
    console.error(`No site export at ${config.SITE_DIR}. Set SITE_DIR, or leave out --ingest to use the committed chunks.`);
    process.exit(2);
  }
  const r = spawnSync(process.execPath, ['src/ingest/index.mjs'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}

if (!existsSync(config.CHUNKS_FILE)) {
  console.error(`No chunks at ${config.CHUNKS_FILE}. They are committed in data/index/; or rebuild them with --ingest from the site export.`);
  process.exit(2);
}

const { loadChunks } = await import('../server/corpus.mjs');
const { embedChunks, embedQuery } = await import('../server/embedder.mjs');
const chunks = loadChunks();
console.log(`${chunks.length} chunks from ${config.CHUNKS_FILE}`);
await embedChunks(chunks, { log: (m) => console.log(m) });
// Loads the model the way a question does, so its files are in the cache.
await embedQuery('warm up');
console.log(`vectors in ${config.EMBEDDINGS_FILE} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
