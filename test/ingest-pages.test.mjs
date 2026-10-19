// Covers: Turning exported Site Pages into search passages: authored text and web parts, the rendered snapshot, excluded draft and test pages, and boilerplate repeated across pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPages, PAGE_EXCLUDE } from '../src/ingest/pages.mjs';

const rte = (html) => `<div data-sp-canvascontrol=""><div data-sp-rte="">${html}</div></div>`;
const webpart = (data) => `<div data-sp-canvascontrol=""><div data-sp-webpartdata='${JSON.stringify(data).replace(/'/g, '&#39;')}'></div></div>`;
const page = (name, fields = {}) => ({ FileLeafRef: name, FileRef: `/sites/BetterCare/SitePages/${name}`, Title: name.replace(/\.aspx$/, ''), CanvasContent1: '', ...fields });

function site(pages, snapshots = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-pages-'));
  mkdirSync(join(dir, 'pages'));
  mkdirSync(join(dir, 'snapshots'));
  pages.forEach((p, i) => writeFileSync(join(dir, 'pages', `${String(i).padStart(3, '0')}.json`), JSON.stringify(p)));
  for (const [name, html] of Object.entries(snapshots)) writeFileSync(join(dir, 'snapshots', name), html);
  return dir;
}

test('PAGE_EXCLUDE: drafts, copies and test pages match; real pages do not', () => {
  const why = (name) => PAGE_EXCLUDE.find(([re]) => re.test(name))?.[1] ?? null;
  assert.equal(why('Wisdom-TEST.aspx'), 'test page');
  assert.equal(why('Abridge-OLD.aspx'), 'superseded copy');
  assert.equal(why('HomeBC-Demo2.aspx'), 'home page design demo');
  assert.equal(why('HomeProposed.aspx'), 'home page design proposal');
  assert.equal(why('Training copy.aspx'), 'copy of another page');
  assert.equal(why('Link.url'), 'external link, not a page');
  assert.equal(why('Page(3).aspx'), 'untitled draft (copies of the Abridge pages)');
  assert.equal(why('Home.aspx'), null);
  assert.equal(why('Texas-A&M-System-Home-to-Nation’s-Fastest-University-Supercomputer.aspx'), null);
});

test('rich text becomes chunks under its headings, with links on the first chunk', () => {
  const dir = site([page('Abridge.aspx', {
    Title: 'Abridge &amp; you',
    Description: 'All about Abridge.',
    Modified: '2026-09-01T10:00:00Z',
    FirstPublishedDate: '2026-01-02T00:00:00Z',
    PromotedState: 0,
    CanvasContent1: rte('<p>Intro text.</p><h2>Getting started</h2><p>Open the <a href="/sites/BetterCare/Guide.pdf">guide</a>.</p><p>Then record.</p>'),
  })]);
  try {
    const { chunks, report } = ingestPages(dir);
    assert.equal(report.pages, 1);
    assert.equal(report.withSnapshot, 0);
    assert.deepEqual(chunks.map((c) => [c.headingPath, c.text]), [
      [[], 'All about Abridge.\nIntro text.'],
      [['Getting started'], 'Open the guide.\nThen record.'],
    ]);
    const c = chunks[0];
    assert.equal(c.id, 'page:Abridge.aspx#0');
    assert.equal(c.sourceType, 'page');
    assert.equal(c.kind, 'page');
    assert.equal(c.title, 'Abridge & you');
    assert.equal(c.url, 'https://uthealthsa.sharepoint.com/sites/BetterCare/SitePages/Abridge.aspx');
    assert.equal(c.localUrl, '/sites/BetterCare/SitePages/Abridge.aspx');
    assert.deepEqual(c.meta, { published: '2026-01-02', modified: '2026-09-01', banner: undefined });
    assert.deepEqual(c.links, [{ text: 'guide', url: 'https://uthealthsa.sharepoint.com/sites/BetterCare/Guide.pdf' }]);
    assert.equal(chunks[1].links, undefined);
  } finally { rmSync(dir, { recursive: true }); }
});

test('web parts: quick links with their URLs, HTML strings and captions', () => {
  const dir = site([page('Links.aspx', { PromotedState: 2, CanvasContent1: webpart({
    properties: { captionText: 'A caption' },
    serverProcessedContent: {
      searchablePlainTexts: { title: 'Quick links', 'items[0].title': 'Help desk', 'items[1].title': 'No link' },
      links: { 'items[0].sourceItem.url': '/sites/BetterCare/Help.aspx' },
      htmlStrings: { body: '<p>Some <b>HTML</b> text</p>' },
    },
  }) })]);
  try {
    const { chunks } = ingestPages(dir);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].kind, 'news', 'PromotedState 2 is a news post');
    assert.deepEqual(chunks[0].headingPath, ['Quick links']);
    assert.equal(chunks[0].text, 'Quick links\n- Help desk (https://uthealthsa.sharepoint.com/sites/BetterCare/Help.aspx)\n- No link\nSome HTML text\nA caption');
    assert.deepEqual(chunks[0].links, [{ text: 'Help desk', url: 'https://uthealthsa.sharepoint.com/sites/BetterCare/Help.aspx' }]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('snapshot adds only text the canvas did not already have; rich text and error web parts are skipped', () => {
  const ctrl = (tag, inner) => `<div data-automation-id="CanvasControl"><div data-sp-feature-tag="${tag}"></div>${inner}</div>`;
  const snapshot = `<html><body>
    ${ctrl('Rich Text web part', '<p>Rich text rendered again, long enough to count for sure.</p>')}
    ${ctrl('FAQ web part', '<h2>FAQ</h2><p>Intro text is here already.</p><p>How do I log in to Epic from home with my token?</p>')}
    ${ctrl('List web part', '<p>Something went wrong while loading this list, sorry.</p>')}
    ${ctrl('Events web part', '<p>short</p>')}
  </body></html>`;
  const dir = site([page('Faq.aspx', { CanvasContent1: rte('<p>Intro text is here already.</p>') })], { 'Faq.html': snapshot });
  try {
    const { chunks, report } = ingestPages(dir);
    assert.equal(report.withSnapshot, 1);
    const texts = chunks.map((c) => c.text).join('\n');
    assert.match(texts, /How do I log in to Epic from home/);
    assert.doesNotMatch(texts, /Rich text rendered again/);
    assert.doesNotMatch(texts, /Something went wrong/);
    assert.equal((texts.match(/Intro text is here already/g) || []).length, 1, 'canvas text is not doubled by the snapshot');
    assert.ok(chunks.some((c) => c.headingPath[0] === 'FAQ'));
  } finally { rmSync(dir, { recursive: true }); }
});

test('excluded pages are reported, including pages whose title marks them as tests', () => {
  const dir = site([
    page('Wisdom-TEST.aspx'),
    page('Draft.aspx', { Title: 'Mary test page' }),
    page('Real.aspx', { CanvasContent1: rte('<p>Real content.</p>') }),
  ]);
  try {
    const { chunks, report } = ingestPages(dir);
    assert.deepEqual(report.excluded, [
      { page: 'Wisdom-TEST.aspx', why: 'test page' },
      { page: 'Draft.aspx', why: 'test page (title "Mary test page")' },
    ]);
    assert.deepEqual([...new Set(chunks.map((c) => c.sourceId))], ['page:Real.aspx']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a page with no text still gets one chunk with its title', () => {
  const dir = site([page('Empty-Page.aspx', { Title: '' })]);
  try {
    const { chunks } = ingestPages(dir);
    assert.deepEqual(chunks.map((c) => [c.title, c.text]), [['Empty Page', 'Empty Page']]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('boilerplate on 3+ pages is kept on Home only', () => {
  const footer = '<p>Help Desk and Epic Service Desk contacts are listed right here for everyone.</p>';
  const dir = site([
    page('Home.aspx', { CanvasContent1: rte(footer) }),
    page('A.aspx', { CanvasContent1: rte(`<h2>A</h2><p>Page A text.</p><h2>Help</h2>${footer}`) }),
    page('B.aspx', { CanvasContent1: rte(`<h2>B</h2><p>Page B text.</p><h2>Help</h2>${footer}`) }),
  ]);
  try {
    const { chunks, report } = ingestPages(dir);
    assert.equal(report.boilerplateDropped, 2);
    const withFooter = chunks.filter((c) => c.text.includes('Help Desk and Epic Service Desk'));
    assert.deepEqual(withFooter.map((c) => c.sourceId), ['page:Home.aspx']);
    assert.ok(chunks.some((c) => c.text === 'Page A text.'));
  } finally { rmSync(dir, { recursive: true }); }
});
