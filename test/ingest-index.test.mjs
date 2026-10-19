// Covers: Assembling the search corpus: list rows in the shared passage shape (hidden and test rows left out), pointing each row at the page that shows it, and the always-indexed help desk footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestLists, linkListRowsToPages, SITE_FOOTER } from '../src/ingest/index.mjs';

function listsDir(lists) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-lists-'));
  for (const l of lists) writeFileSync(join(dir, `${l.list}.json`), JSON.stringify(l));
  return dir;
}

test('SITE_FOOTER carries the help desk number and email, in the passage shape', () => {
  assert.equal(SITE_FOOTER.id, 'site:footer');
  assert.match(SITE_FOOTER.text, /210\) 450-4800/);
  assert.match(SITE_FOOTER.text, /HealthITSupport@uthscsa\.edu/);
  for (const k of ['id', 'sourceId', 'sourceType', 'kind', 'title', 'headingPath', 'text', 'url', 'localUrl', 'list', 'meta']) assert.ok(k in SITE_FOOTER, k);
});

test('ingestLists: rows become list-item passages; hidden, test and placeholder rows are left out', () => {
  const dir = listsDir([
    { list: 'FAQCategories', id: 'c', items: [{ Id: 1, Title: 'Login' }] },
    { list: 'FAQQuestions', id: 'g', items: [
      { Id: 1, Title: 'How do I sign in to Epic?', Answers: '<p>Use your UT Health ID.</p>', CategoryId: 1 },
      { Id: 2, Title: 'Test question', Answers: '<p>Real looking answer text.</p>', CategoryId: 1 },
      { Id: 3, Title: 'Another real question?', Answers: '<p>testing 123</p>', CategoryId: 1 },
    ] },
    { list: 'EpicUpgrades', id: 'u', items: [{ Id: 1, Title: 'Hidden module', field_4: 'Not live yet', Display: 'no' }] },
  ]);
  try {
    const { chunks, report } = ingestLists(dir);
    assert.deepEqual(chunks.map((c) => c.id), ['list:FAQQuestions:1']);
    const c = chunks[0];
    assert.equal(c.sourceId, 'list:FAQQuestions:1');
    assert.equal(c.sourceType, 'list-item');
    assert.equal(c.kind, 'faq');
    assert.deepEqual(c.headingPath, ['Login']);
    assert.equal(c.localUrl, null);
    assert.deepEqual(report.testRows, ['FAQQuestions: "Test question"', 'FAQQuestions: placeholder text']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('linkListRowsToPages: a row points at the page whose text shows its title, preferring non-news pages', () => {
  const pages = [
    { sourceId: 'page:News.aspx', kind: 'news', title: 'News', url: 'https://x/News.aspx', localUrl: '/News.aspx', text: 'We now support Haiku on Android phones.' },
    { sourceId: 'page:Haiku.aspx', kind: 'page', title: 'Haiku', url: 'https://x/Haiku.aspx', localUrl: '/Haiku.aspx', text: 'FAQ\nHAIKU ON ANDROID PHONES works like this.' },
    { sourceId: 'page:Haiku.aspx', kind: 'page', title: 'Haiku', url: 'https://x/Haiku.aspx', localUrl: '/Haiku.aspx', text: 'second chunk' },
  ];
  const rows = [
    { title: 'Haiku on Android phones', localUrl: null, meta: { category: 'Mobile' } },
    { title: 'Short', localUrl: null },                 // under 8 characters: never matched
    { title: 'Nowhere to be found', localUrl: null },
  ];
  assert.equal(linkListRowsToPages(rows, pages), 1);
  assert.equal(rows[0].localUrl, '/Haiku.aspx');
  assert.deepEqual(rows[0].meta, { category: 'Mobile', shownOn: 'Haiku', shownOnUrl: 'https://x/Haiku.aspx' });
  assert.equal(rows[1].localUrl, null);
  assert.equal(rows[2].localUrl, null);
});

test('linkListRowsToPages: falls back to a news page when that is the only one showing the row', () => {
  const rows = [{ title: 'Abridge pilot expands', localUrl: null }];
  linkListRowsToPages(rows, [{ sourceId: 'page:N.aspx', kind: 'news', title: 'N', url: 'u', localUrl: '/N.aspx', text: 'abridge pilot expands to clinics' }]);
  assert.equal(rows[0].localUrl, '/N.aspx');
});
