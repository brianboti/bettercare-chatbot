// Covers: Loading the search passages (the text each one is searched by) and the embedding cache that keeps search vectors from being recomputed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChunks, KIND_LABEL, CHUNKS_FILE, ROOT } from '../server/corpus.mjs';
import { embedChunks } from '../server/embedder.mjs';
import { config } from '../server/config.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-corpus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the corpus lives at data/index/chunks.json under the project root', () => {
  assert.equal(CHUNKS_FILE, join(ROOT, 'data/index/chunks.json'));
  assert.equal(KIND_LABEL.faq, 'FAQ');
  assert.equal(KIND_LABEL.slides, 'Slide deck');
});

test('a missing corpus says how to build it', (t) => {
  const dir = tempDir(t);
  assert.throws(() => loadChunks(join(dir, 'none.json')), /Run: npm run ingest/);
});

test('each passage is searched by its kind, where it sits, its folder, its text and its list details', (t) => {
  const file = join(tempDir(t), 'chunks.json');
  writeFileSync(file, JSON.stringify([
    {
      id: 'doc', kind: 'slides', title: 'vFeb2026 Overview', headingPath: ['Ambulatory', 'In Basket'], text: 'New In Basket folders.',
      sourceType: 'document', meta: { folder: 'Upgrade vFebruary2026' },
    },
    {
      id: 'row', kind: 'catalog', list: 'Tip Sheets', title: 'Check-in tip sheet', text: 'How to check in a patient.', sourceType: 'list-item',
      meta: { application: 'Cadence', roles: ['Front desk', 'Patient Check-In'], upgrade: 'vMay2026', phase: 'Phase 2', status: undefined, documentUrl: 'https://example.org/tip.pdf' },
      links: [{ url: 'https://example.org/other' }],
    },
    { id: 'row2', kind: 'mystery', list: 'L', title: 'T', text: 'x', sourceType: 'list-item', links: [{ url: 'https://example.org/first-link' }] },
  ]));
  const [doc, row, row2] = loadChunks(file);

  assert.equal(doc.indexText, 'Slide deck — \nvFeb2026 Overview > Ambulatory > In Basket\nFolder: Upgrade vFebruary2026\nNew In Basket folders.');
  assert.equal(doc.docUrl, null, 'only list rows point at a document');

  assert.equal(row.indexText, [
    'Tip sheet / training document listing — Tip Sheets',
    'Check-in tip sheet',
    'How to check in a patient.',
    'Application: Cadence',
    'Upgrade: vMay2026, Phase 2',
    'Roles: Front desk, Patient Check-In',
  ].join('\n'));
  assert.equal(row.docUrl, 'https://example.org/tip.pdf');

  assert.match(row2.indexText, /^mystery — L/, 'an unknown kind is shown as itself');
  assert.equal(row2.docUrl, 'https://example.org/first-link', 'no document link: the first link');
  assert.equal(row2.text, 'x', 'the original fields are kept');
});

// ---------------------------------------------------------------- embedding cache

const chunk = (id, indexText) => ({ id, indexText });

/** A fake embedder that records what it was asked to embed. */
function fakeEmbedder() {
  const calls = [];
  const embedTexts = async (texts) => { calls.push(texts); return texts.map((t) => Float32Array.from([t.length / 100, 0.123456789])); };
  return { calls, embedTexts };
}

test('embedding: the first run embeds everything and saves it, rounded', async (t) => {
  const cacheFile = join(tempDir(t), 'embeddings.json');
  const fake = fakeEmbedder();
  const logs = [];
  const v = await embedChunks([chunk('a', 'alpha'), chunk('b', 'beta!')], { cacheFile, embedTexts: fake.embedTexts, log: (m) => logs.push(m) });
  assert.deepEqual(fake.calls, [['alpha', 'beta!']]);
  assert.ok(v.get('a') instanceof Float32Array);
  assert.ok(Math.abs(v.get('b')[0] - 0.05) < 1e-6);
  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.model, config.EMBEDDING_MODEL);
  assert.equal(saved.items.a.v[1], 0.12346, 'stored to 5 decimals');
  assert.match(logs[0], /embedding 2 of 2 chunks/);
});

test('embedding: only new or changed passages are embedded again; deleted ones are dropped', async (t) => {
  const cacheFile = join(tempDir(t), 'embeddings.json');
  const fake = fakeEmbedder();
  await embedChunks([chunk('a', 'alpha'), chunk('b', 'beta'), chunk('gone', 'old')], { cacheFile, embedTexts: fake.embedTexts });
  fake.calls.length = 0;

  await embedChunks([chunk('a', 'alpha'), chunk('b', 'beta, edited'), chunk('c', 'new')], { cacheFile, embedTexts: fake.embedTexts });
  assert.deepEqual(fake.calls, [['beta, edited', 'new']]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).items).sort(), ['a', 'b', 'c']);
});

test('embedding: nothing changed means no model call and no rewrite of the cache', async (t) => {
  const cacheFile = join(tempDir(t), 'embeddings.json');
  const fake = fakeEmbedder();
  const chunks = [chunk('a', 'alpha')];
  await embedChunks(chunks, { cacheFile, embedTexts: fake.embedTexts });
  writeFileSync(cacheFile, readFileSync(cacheFile, 'utf8').replace('"model"', '"model" '));   // marker: whitespace only
  const before = readFileSync(cacheFile, 'utf8');
  fake.calls.length = 0;
  await embedChunks(chunks, { cacheFile, embedTexts: fake.embedTexts });
  assert.equal(fake.calls.length, 0);
  assert.equal(readFileSync(cacheFile, 'utf8'), before);
});

test('embedding: a cache from another model, or an unreadable one, is rebuilt', async (t) => {
  const dir = tempDir(t);
  const other = join(dir, 'other.json');
  writeFileSync(other, JSON.stringify({ model: 'some-other-model', items: { a: { h: 'x', v: [1, 2] } } }));
  const fake = fakeEmbedder();
  await embedChunks([chunk('a', 'alpha')], { cacheFile: other, embedTexts: fake.embedTexts });
  assert.deepEqual(fake.calls, [['alpha']]);
  assert.equal(JSON.parse(readFileSync(other, 'utf8')).model, config.EMBEDDING_MODEL);

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  fake.calls.length = 0;
  await embedChunks([chunk('a', 'alpha')], { cacheFile: broken, embedTexts: fake.embedTexts });
  assert.deepEqual(fake.calls, [['alpha']]);
  assert.ok(existsSync(broken));
});
