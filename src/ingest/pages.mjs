// Site Pages -> chunks.
//
// Two sources per page, combined:
//   1. CanvasContent1 (from the REST export) — the authored layout: rich-text
//      web parts plus each web part's serverProcessedContent (titles, link
//      labels, HTML strings). Complete and authoritative for static content.
//   2. The rendered snapshot — adds what only exists at render time: FAQ
//      accordions, news and event rollups, list views, custom web parts.
// Snapshot text already present in the canvas text is dropped, so the two
// don't double up.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { clean, textOf, chunkSections, spUrl, sha, absUrl } from './common.mjs';
import { testMarker } from './test-content.mjs';

/**
 * Pages that are drafts, tests or superseded copies. Matched against the file
 * name; each is reported, never silently dropped.
 */
export const PAGE_EXCLUDE = [
  [{ test: (name) => !!testMarker(name) }, 'test page'],
  [/-OLD\.aspx$/i, 'superseded copy'],
  [/^HomeBC-Demo/i, 'home page design demo'],
  [/^HomeProposed\.aspx$/i, 'home page design proposal'],
  [/copy\.aspx$/i, 'copy of another page'],
  [/\.url$/i, 'external link, not a page'],
  [/^Page\(\d+\)\.aspx$/i, 'untitled draft (copies of the Abridge pages)'],
];

const RTE_SKIP = /^(Something went wrong|If the problem persists|Loading|Correlation ID)/i;

/** Parse the JSON in a data-sp-webpartdata attribute. */
function wpData(el) {
  try { return JSON.parse(el.getAttribute('data-sp-webpartdata')); } catch { return null; }
}

/** Sections from the authored canvas. */
function canvasSections(canvasHtml) {
  const sections = [];
  const links = [];
  if (!canvasHtml) return { sections, links };
  const { document } = parseHTML(`<!doctype html><html><body>${canvasHtml}</body></html>`);
  let heading = null;

  for (const ctrl of document.querySelectorAll('[data-sp-canvascontrol]')) {
    const rte = ctrl.querySelector('[data-sp-rte]');
    if (rte) {
      let buf = [];
      const flush = () => { if (buf.length) sections.push({ heading, text: buf.join('\n') }); buf = []; };
      for (const el of rte.children) {
        if (/^H[1-4]$/.test(el.tagName)) {
          flush();
          heading = clean(el.textContent) || heading;
        } else {
          const t = textOf(el);
          if (t) buf.push(t);
        }
        for (const a of el.querySelectorAll?.('a[href]') || []) links.push({ text: clean(a.textContent), url: absUrl(a.getAttribute('href')) });
      }
      flush();
      continue;
    }

    const wpEl = ctrl.querySelector('[data-sp-webpartdata]');
    const wp = wpEl && wpData(wpEl);
    if (!wp) continue;
    const spc = wp.serverProcessedContent || {};
    const plain = spc.searchablePlainTexts || {};
    const lines = [];
    const title = plain.title || wp.properties?.title || null;

    // Quick links / hero / call-to-action: items[i].title + links[i].url
    for (const [k, v] of Object.entries(plain)) {
      if (k === 'title' || !v) continue;
      const m = /^(items\[\d+\])\./.exec(k);
      const url = absUrl(m && (spc.links?.[`${m[1]}.sourceItem.url`] || spc.links?.[`${m[1]}.url`]));
      lines.push(url ? `- ${clean(v)} (${url})` : `- ${clean(v)}`);
      if (url) links.push({ text: clean(v), url });
    }
    for (const html of Object.values(spc.htmlStrings || {})) {
      const t = textOf(parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body);
      if (t) lines.push(t);
    }
    if (wp.properties?.captionText) lines.push(clean(wp.properties.captionText));
    if (lines.length) sections.push({ heading: title || heading, text: (title ? `${title}\n` : '') + lines.join('\n') });
  }
  return { sections, links };
}

/** Sections from the rendered snapshot, for web parts whose text isn't in the canvas. */
function snapshotSections(html, known) {
  const { document } = parseHTML(html);
  const sections = [];
  for (const ctrl of document.querySelectorAll('[data-automation-id="CanvasControl"]')) {
    const tag = ctrl.querySelector('[data-sp-feature-tag]')?.getAttribute('data-sp-feature-tag') || '';
    if (/Rich Text|PageTitle|Image web part|Divider|Spacer/i.test(tag)) continue;
    const text = textOf(ctrl);
    if (!text || text.length < 30 || RTE_SKIP.test(text)) continue;
    // Keep only lines the canvas didn't already give us.
    const fresh = text.split('\n').filter((l) => {
      const k = l.replace(/^- /, '').toLowerCase().trim();
      return k.length > 2 && !known.has(k);
    });
    if (fresh.join(' ').length < 30) continue;
    const heading = clean(ctrl.querySelector('h2, h3, [role="heading"]')?.textContent) || tag.replace(/ web part.*$/, '') || null;
    sections.push({ heading, text: fresh.join('\n') });
  }
  return sections;
}

export function ingestPages(siteDir) {
  const pagesDir = resolve(siteDir, 'pages');
  const snapDir = resolve(siteDir, 'snapshots');
  const report = { pages: 0, excluded: [], chunks: 0, withSnapshot: 0, boilerplateDropped: 0 };
  const chunks = [];

  // Pass 1: sections for every page.
  const pages = [];
  for (const f of readdirSync(pagesDir).sort()) {
    const p = JSON.parse(readFileSync(resolve(pagesDir, f), 'utf8'));
    const name = p.FileLeafRef;
    const rule = PAGE_EXCLUDE.find(([re]) => re.test(name));
    if (rule) { report.excluded.push({ page: name, why: rule[1] }); continue; }
    if (testMarker(clean(p.Title))) { report.excluded.push({ page: name, why: `test page (title "${clean(p.Title)}")` }); continue; }
    report.pages++;

    const { sections, links } = canvasSections(p.CanvasContent1);
    const known = new Set(sections.flatMap((s) => s.text.split('\n')).map((l) => l.replace(/^- /, '').replace(/ \(https?:[^)]*\)$/, '').toLowerCase().trim()));

    const snap = resolve(snapDir, `${name.replace(/\.aspx$/i, '')}.html`);
    if (existsSync(snap)) {
      report.withSnapshot++;
      sections.push(...snapshotSections(readFileSync(snap, 'utf8'), known));
    }
    pages.push({ p, name, sections, links });
  }

  // Boilerplate: web parts copied onto many pages (the "Help Desk / Epic
  // Service Desk" quick links are on dozens) would otherwise fill every
  // result list. Keep each on one page only — Home if it's there.
  const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const onPages = new Map();
  for (const { name, sections } of pages) {
    for (const s of sections) {
      const k = norm(s.text);
      if (k.length < 40) continue;
      if (!onPages.has(k)) onPages.set(k, []);
      if (!onPages.get(k).includes(name)) onPages.get(k).push(name);
    }
  }
  const home = (list) => list.find((n) => /^home\.aspx$/i.test(n)) || list[0];

  // Pass 2: chunks.
  for (const { p, name, sections: all, links } of pages) {
    const sections = all.filter((s) => {
      const where = onPages.get(norm(s.text));
      if (!where || where.length < 3 || home(where) === name) return true;
      report.boilerplateDropped++;
      return false;
    });

    const title = clean(p.Title) || name.replace(/\.aspx$/i, '').replace(/-/g, ' ');
    if (p.Description) sections.unshift({ heading: null, text: clean(p.Description) });
    if (!sections.length) sections.push({ heading: null, text: title });

    const isNews = p.PromotedState === 2;
    const pageUrl = spUrl(p.FileRef);
    const pieces = chunkSections(sections);
    pieces.forEach((c, i) => {
      chunks.push({
        id: `page:${name}#${i}`,
        sourceId: `page:${name}`,
        sourceType: 'page',
        kind: isNews ? 'news' : 'page',
        title,
        headingPath: c.headingPath,
        text: c.text,
        url: pageUrl,
        localUrl: pageUrl.replace(/^https:\/\/[^/]+/, ''),   // the replica serves the same paths
        list: 'Site Pages',
        meta: {
          published: p.FirstPublishedDate ? p.FirstPublishedDate.slice(0, 10) : undefined,
          modified: p.Modified?.slice(0, 10),
          banner: p.BannerImageUrl?.Url || undefined,
        },
        hash: sha(c.text),
      });
    });
    // Links are recorded on the first chunk of the page for citation display.
    if (pieces.length && links.length) chunks[chunks.length - pieces.length].links = dedupeLinks(links).slice(0, 40);
    report.chunks += pieces.length;
  }
  return { chunks, report };
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((l) => l.url && !seen.has(l.url) && seen.add(l.url)).map((l) => ({
    text: l.text || l.url,
    url: absUrl(l.url),
  }));
}
