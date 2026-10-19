// Covers: Search: splitting text into search words, keyword and meaning-based matching, merging the two, limits per source, dropping near-copies, and the weak-match signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildRetriever } from '../server/retriever.mjs';

// Fake embeddings: every vector is unit length, so the dot product is the cosine.
const unit = (...xs) => { const n = Math.hypot(...xs) || 1; return Float32Array.from(xs.map((x) => x / n)); };

/** A chunk as loadChunks() returns it. */
function chunk(id, title, text, extra = {}) {
  return { id, title, text, headingPath: [], sourceType: 'page', kind: 'page', indexText: `${title}\n${text}`, meta: {}, ...extra };
}

/** A retriever over `rows` ([chunk, vector]); query vectors come from `queries` (default: far from everything). */
async function retriever(rows, queries = {}) {
  const asked = [];
  const r = await buildRetriever(rows.map(([c]) => c), {
    vectors: new Map(rows.map(([c, v]) => [c.id, v])),
    embedQuery: async (q) => { asked.push(q); return queries[q] || unit(0, 0, 0, 1); },
  });
  return { ...r, asked };
}

const ids = (res) => res.results.map((c) => c.id);

test('tokenize: lowercase, no accents, punctuation or stop words, light suffix folding', () => {
  assert.deepEqual(tokenize('How do I find the Café upgrades?'), ['cafe', 'upgrade']);
  assert.deepEqual(tokenize('training policies scheduled classes'), ['train', 'policy', 'schedul', 'classe']);
  assert.deepEqual(tokenize('class access'), ['class', 'access'], "words ending in 'ss' keep their s");
  assert.deepEqual(tokenize('a I x 7 is'), [], 'one-letter words and stop words are dropped');
  assert.deepEqual(tokenize('vAugust2024 SlicerDicer!'), ['vaugust2024', 'slicerdicer']);
  assert.deepEqual(tokenize(42), ['42'], 'non-strings are converted');
});

test('keyword search finds exact names that the meaning search misses', async () => {
  const r = await retriever([
    [chunk('sd', 'Reporting', 'Build a SlicerDicer session to count patients.'), unit(1, 0, 0, 0)],
    [chunk('other', 'Haiku', 'Epic on your phone.'), unit(0, 1, 0, 0)],
  ], { SlicerDicer: unit(0, 1, 0, 0) });
  const res = await r.retrieve('SlicerDicer');
  const sd = res.results.find((c) => c.id === 'sd');
  assert.ok(sd.retrievedBy.includes('keyword'));
  assert.ok(sd.bm25 > 0);
  assert.equal(ids(res)[0], 'sd', 'found by both lists beats found by one');
});

test('meaning search finds the right page with none of the same words', async () => {
  const r = await retriever([
    [chunk('haiku', 'Haiku', 'The Epic mobile app.'), unit(1, 0, 0, 0)],
    [chunk('beaker', 'Beaker', 'The lab system.'), unit(0, 1, 0, 0)],
  ], { 'cellular gadget software': unit(0.95, 0.05, 0, 0) });
  const res = await r.retrieve('cellular gadget software');
  assert.equal(ids(res)[0], 'haiku');
  assert.deepEqual(res.results[0].retrievedBy, ['vector']);
  assert.equal(res.results[0].bm25, null, 'no keyword score when keyword search did not find it');
  assert.ok(res.results[0].cosine > 0.9);
});

test("everyday words reach the site's vocabulary: phone finds Haiku", async () => {
  const r = await retriever([
    [chunk('haiku', 'Haiku setup', 'Install Haiku from the app store.'), unit(1, 0, 0, 0)],
    [chunk('beaker', 'Beaker', 'Lab orders.'), unit(0, 1, 0, 0)],
  ]);
  const res = await r.retrieve('phone');
  const haiku = res.results.find((c) => c.id === 'haiku');
  assert.ok(haiku.retrievedBy.includes('keyword'));
});

test('a word in the title counts more than the same word in the body', async () => {
  const r = await retriever([
    [chunk('body', 'Lab news', 'Beaker is getting new specimen labels next month.'), unit(1, 0, 0, 0)],
    [chunk('title', 'Beaker', 'Specimen labels and printers for the lab.'), unit(0, 1, 0, 0)],
  ]);
  const res = await r.retrieve('Beaker');
  const bm = Object.fromEntries(res.results.map((c) => [c.id, c.bm25]));
  assert.ok(bm.title > bm.body);
});

test('a question that is only stop words still gets meaning-based results', async () => {
  const r = await retriever([[chunk('a', 'Anything', 'text'), unit(1, 0, 0, 0)]], { 'what is the': unit(1, 0, 0, 0) });
  const res = await r.retrieve('what is the');
  assert.deepEqual(ids(res), ['a']);
  assert.deepEqual(res.results[0].retrievedBy, ['vector']);
});

test('at most 3 passages per document, however well the rest match', async () => {
  const rows = [0, 1, 2, 3, 4].map((n) => [chunk(`d${n}`, 'Haiku Tip Sheet', `Haiku part ${n}`), unit(1, n * 0.5, n, 0)]);
  rows.push([chunk('x', 'Canto', 'Haiku on the iPad is Canto.'), unit(0, 0, 0, 1)]);
  // Same title spelled differently (a PDF and a PowerPoint copy) shares the budget.
  rows.push([chunk('d5', 'haiku-tip-sheet', 'Haiku copy'), unit(1, 0, 3, 0)]);
  const r = await retriever(rows, { Haiku: unit(1, 0, 0, 0) });
  const res = await r.retrieve('Haiku');
  assert.equal(res.results.filter((c) => /^d/.test(c.id)).length, 3);
  assert.ok(ids(res).includes('x'));
  assert.equal((await r.retrieve('Haiku', { maxPerSource: 1 })).results.filter((c) => /^d/.test(c.id)).length, 1);
});

test('list rows: at most 2 per title, and near-identical rows are kept', async () => {
  // A class repeated on several dates: same text, same vector.
  const rows = [1, 2, 3, 4].map((n) => [chunk(`c${n}`, 'Thrive Class', 'Thrive training class', { sourceType: 'list-item', kind: 'event' }), unit(1, 0, 0, 0)]);
  const r = await retriever(rows, { Thrive: unit(1, 0, 0, 0) });
  assert.equal((await r.retrieve('Thrive')).results.length, 2);
});

test('pages that are near copies of one already chosen are dropped', async () => {
  const r = await retriever([
    [chunk('a', 'Downtime guide', 'BCA downtime steps'), unit(1, 0, 0, 0)],
    [chunk('b', 'Downtime guide (copy)', 'BCA downtime steps'), unit(1, 0.01, 0, 0)],
    [chunk('c', 'Downtime FAQ', 'BCA questions'), unit(1, 1, 0, 0)],
  ], { downtime: unit(1, 0, 0, 0) });
  const got = ids(await r.retrieve('downtime'));
  assert.ok(got.includes('a') && got.includes('c'));
  assert.ok(!got.includes('b'));
});

test('topK limits how many passages come back (broad questions ask for more)', async () => {
  // Twenty different pages (pairwise cosine 0.64, so none is a near copy).
  const axis = (n) => Array.from({ length: 21 }, (_, i) => (i === 0 ? 0.8 : i === n + 1 ? 0.6 : 0));
  const rows = Array.from({ length: 20 }, (_, n) => [chunk(`p${n}`, `Upgrade page ${n}`, 'upgrade notes'), Float32Array.from(axis(n))]);
  const r = await retriever(rows, { upgrade: Float32Array.from(axis(-1).map((x, i) => (i === 0 ? 1 : 0))) });
  assert.equal((await r.retrieve('upgrade')).results.length, 8, 'default top 8');
  assert.equal((await r.retrieve('upgrade', { topK: 16 })).results.length, 16);
  assert.equal((await r.retrieve('upgrade', { topK: 3 })).results.length, 3);
});

test('confidence is the best meaning match; below 0.69 it is flagged weak', async () => {
  const rows = [[chunk('a', 'Abridge', 'ambient scribe'), unit(1, 0, 0, 0)]];
  const r = await retriever(rows, { strong: unit(1, 0.1, 0, 0), weak: unit(0.5, 1, 0, 0) });
  const strong = await r.retrieve('strong');
  assert.ok(strong.confidence > 0.9);
  assert.equal(strong.lowConfidence, false);
  const weak = await r.retrieve('weak');
  assert.ok(Math.abs(weak.confidence - 0.5 / Math.hypot(0.5, 1)) < 1e-6);
  assert.equal(weak.lowConfidence, true);
});

test('several phrasings are each searched once and merged', async () => {
  const r = await retriever([
    [chunk('a', 'Haiku', 'mobile app'), unit(1, 0, 0, 0)],
    [chunk('b', 'Canto', 'tablet app'), unit(0, 1, 0, 0)],
  ], { 'one phrasing': unit(1, 0, 0, 0), 'another phrasing': unit(0, 1, 0, 0) });
  const res = await r.retrieve(['one phrasing', ' one phrasing ', 'another phrasing', '   ']);
  assert.deepEqual(r.asked, ['one phrasing', 'another phrasing'], 'trimmed, de-duplicated, blanks dropped');
  assert.deepEqual(ids(res).sort(), ['a', 'b']);
});

test('"the last upgrade" is searched as the actual version name', async () => {
  const timeline = (v, date) => chunk(`t-${v}`, v, `${v} go-live`, { sourceType: 'list-item', list: 'Upgrade Timeline', meta: { date } });
  const r = await retriever([
    [timeline('vFeb2020', '2020-02-01'), unit(0, 1, 0, 0)],
    [timeline('vMay2020', '2020-05-01'), unit(0, 1, 0, 0)],
    [chunk('notes', 'Release notes vMay2020', 'What changed'), unit(0, 0, 1, 0)],
  ]);
  const res = await r.retrieve('what changed in the last upgrade');
  assert.match(r.asked[0], /vMay2020/);
  assert.ok(ids(res).includes('notes'));
  assert.equal(r.facts.context().last.version, 'vMay2020');
});

test('results carry their scores, and get() looks a passage up by id', async () => {
  const c = chunk('a', 'Abridge', 'ambient scribe');
  const r = await retriever([[c, unit(1, 0, 0, 0)]], { Abridge: unit(1, 0, 0, 0) });
  const [hit] = (await r.retrieve('Abridge')).results;
  assert.equal(hit.title, 'Abridge');
  assert.equal(typeof hit.score, 'number');
  assert.deepEqual(hit.retrievedBy, ['vector', 'keyword']);
  assert.equal(r.size, 1);
  assert.equal(r.get('a'), c);
  assert.equal(r.get('missing'), null);
});
