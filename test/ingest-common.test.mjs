// Covers: The shared ingest helpers: text cleanup, SharePoint links, page text from HTML, and splitting text into search passages of the right size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { sha, clean, spUrl, textOf, tidy, absUrl, chunkSections, CHUNK_WORDS, OVERLAP_WORDS, ORIGIN, SITE } from '../src/ingest/common.mjs';

const wc = (s) => (s.match(/\S+/g) || []).length;
const sentence = (i, n = 10) => `${Array.from({ length: n - 1 }, (_, j) => `w${i}x${j}`).join(' ')} end${i}.`;

test('constants point at the BetterCare site', () => {
  assert.equal(ORIGIN, 'https://uthealthsa.sharepoint.com');
  assert.ok(SITE.startsWith(ORIGIN));
  assert.ok(OVERLAP_WORDS < CHUNK_WORDS);
});

test('sha: stable hex digest, length adjustable', () => {
  assert.equal(sha('abc'), 'a9993e364706');
  assert.equal(sha('abc', 4), 'a999');
  assert.notEqual(sha('abc'), sha('abd'));
});

test('clean: entities, zero-width characters, non-breaking spaces and blank lines', () => {
  assert.equal(clean('Tom &amp; Jerry​  here'), 'Tom & Jerry here');
  assert.equal(clean(' a \n\n\n\n b '), 'a\n\nb');
  assert.equal(clean(null), '');
  assert.equal(clean(undefined), '');
});

test('spUrl: absolute and safely encoded, including # in file names', () => {
  assert.equal(spUrl('/sites/BetterCare/Shared Documents/Tip #1.pdf'), 'https://uthealthsa.sharepoint.com/sites/BetterCare/Shared%20Documents/Tip%20%231.pdf');
});

test('absUrl: only site-relative links get the origin', () => {
  assert.equal(absUrl('/sites/BetterCare/x.aspx'), 'https://uthealthsa.sharepoint.com/sites/BetterCare/x.aspx');
  assert.equal(absUrl('https://other.org/x'), 'https://other.org/x');
  assert.equal(absUrl(undefined), undefined);
  assert.equal(absUrl(''), '');
});

test('textOf: block boundaries become lines, list items bullets, hidden parts skipped', () => {
  const { document } = parseHTML(`<html><body><div>
    <h2>Title</h2><p>Para one</p>
    <ul><li>Item A</li><li>Item B</li></ul>
    <script>alert(1)</script><style>p{}</style><span aria-hidden="true">icon</span>
    <table><tr><td>c1</td><td>c2</td></tr></table>
  </div></body></html>`);
  assert.equal(textOf(document.body), 'Title\nPara one\n- Item A\n- Item B\nc1 | c2');
});

test('tidy: numbered markers fold into the next line; orphan markers are dropped', () => {
  assert.equal(tidy('1.\nOpen Epic\n2.\n- Click Chart\n|\n-\n•\nDone'), '1. Open Epic\n2. Click Chart\nDone');
  assert.equal(tidy('| a | b |'), 'a | b');
});

test('chunkSections: small sections under one heading are merged; empty ones skipped', () => {
  const out = chunkSections([{ heading: 'H', text: 'one' }, { heading: 'H', text: 'two' }, { heading: 'H', text: '   ' }, { heading: 'Other', text: 'three' }]);
  assert.deepEqual(out, [{ headingPath: ['H'], text: 'one\ntwo' }, { headingPath: ['Other'], text: 'three' }]);
});

test('chunkSections: no heading gives an empty heading path', () => {
  assert.deepEqual(chunkSections([{ text: 'hello' }]), [{ headingPath: [], text: 'hello' }]);
});

test('chunkSections: never merges across headings', () => {
  const out = chunkSections([{ heading: 'A', text: 'x' }, { heading: 'B', text: 'y' }, { heading: 'A', text: 'z' }]);
  assert.deepEqual(out.map((c) => c.headingPath[0]), ['A', 'B', 'A']);
});

test('chunkSections: long sections split at about CHUNK_WORDS with paragraph overlap', () => {
  // 60 paragraphs of 10 words = 600 words.
  const paras = Array.from({ length: 60 }, (_, i) => sentence(i));
  const out = chunkSections([{ heading: 'Long', text: paras.join('\n') }]);
  assert.ok(out.length >= 3, `expected several chunks, got ${out.length}`);
  for (const c of out) assert.ok(wc(c.text) <= CHUNK_WORDS, `chunk of ${wc(c.text)} words`);
  // Consecutive chunks share up to OVERLAP_WORDS of trailing paragraphs.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].text.split('\n');
    const first = out[i].text.split('\n')[0];
    assert.ok(prev.includes(first), 'next chunk starts with a paragraph from the previous one');
    const shared = out[i].text.split('\n').filter((p) => prev.includes(p));
    assert.ok(wc(shared.join(' ')) <= OVERLAP_WORDS);
  }
  // Every paragraph appears somewhere.
  const all = new Set(out.flatMap((c) => c.text.split('\n')));
  for (const p of paras) assert.ok(all.has(p));
});

test('chunkSections: a single paragraph longer than the limit is split by sentence, then by word', () => {
  const longPara = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ');   // 500 words, one line
  const out = chunkSections([{ text: longPara }], { words: 100, overlap: 0 });
  assert.ok(out.length >= 5);
  for (const c of out) assert.ok(wc(c.text) <= 100);
  const noStops = Array.from({ length: 250 }, (_, i) => `w${i}`).join(' ');     // one 250-word "sentence"
  const out2 = chunkSections([{ text: noStops }], { words: 100, overlap: 0 });
  assert.deepEqual(out2.map((c) => wc(c.text)), [100, 100, 50]);
});

test('chunkSections: custom sizes are honoured', () => {
  const text = Array.from({ length: 10 }, (_, i) => `p${i} a b c d`).join('\n');  // 10 × 5 words
  const out = chunkSections([{ text }], { words: 20, overlap: 5 });
  for (const c of out) assert.ok(wc(c.text) <= 20);
  assert.ok(out.length > 2);
});
