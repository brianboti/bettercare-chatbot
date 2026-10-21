// The local BetterCare replica.
//
// Serves the exported site at the same paths SharePoint uses
// (/sites/BetterCare/SitePages/Haiku.aspx, /sites/BetterCare/Shared Documents/…),
// so every internal link in the captured pages just works.
//
// Each page is its rendered snapshot (tools/export-site.browser.js), with:
//   - the suite bar and site header grafted in from a capture of the live
//     top-level page (SharePoint hides both when a page is framed, which is how
//     the snapshots were taken)
//   - links to other pages and files rewritten to stay local, and anything not
//     in the export opened on the real site in a new tab
//   - the assistant (site/assistant.js) injected: the Copilot-style pane and
//     the AI-powered search box

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { config } from '../server/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(config.SITE_DIR);
const SNAP_DIR = resolve(SITE_DIR, 'snapshots');
const FILES_DIR = resolve(SITE_DIR, 'files');
const PREFIX = '/sites/BetterCare/';
const ORIGIN = 'https://uthealthsa.sharepoint.com';

const REMOTE_DIR = resolve(SITE_DIR, 'remote');
// Image hosts that need a SharePoint sign-in; their images are fetched once
// by the exporter (bcExport.remoteAssets) and served locally.
const AUTH_IMAGE_HOSTS = /^https:\/\/(uthealthsa\.sharepoint\.com|media\.akamai\.odsp\.cdn\.office\.net|cdn\.hubblecontent\.osi\.office\.net)\//i;
const remoteKey = (u) => createHash('sha1').update(u).digest('hex').slice(0, 20);
const remoteUrls = new Set();

/** Local URL for an auth-only image, falling back to the original. */
function localImage(src) {
  if (!src || !AUTH_IMAGE_HOSTS.test(src)) return src;
  remoteUrls.add(src);
  return existsSync(resolve(REMOTE_DIR, remoteKey(src))) ? `/_replica/remote/${remoteKey(src)}` : src;
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);

let chrome = null;            // { suiteNav, siteHeader, css }
const listsById = new Map();  // list GUID -> exported list
const faqConfigs = new Map(); // lowercased page name -> Modern FAQ web part properties, in page order
let siteJson = null;
const pages = new Map();      // lowercased page file name -> snapshot path
const rendered = new Map();   // cache: page -> html

/** True once init() found an export to serve. */
export const available = () => pages.size > 0;

export function init() {
  if (!existsSync(SNAP_DIR)) return;
  for (const f of readdirSync(resolve(SITE_DIR, 'pages'))) {
    const p = JSON.parse(readFileSync(resolve(SITE_DIR, 'pages', f), 'utf8'));
    const snap = resolve(SNAP_DIR, `${safe(p.FileLeafRef.replace(/\.aspx$/i, ''))}.html`);
    if (existsSync(snap)) pages.set(p.FileLeafRef.toLowerCase(), snap);
  }
  try { siteJson = JSON.parse(readFileSync(resolve(SITE_DIR, 'site.json'), 'utf8')); } catch { /* optional */ }

  // The "Modern FAQ" web part is a third-party SPFx part that fails when a
  // page is framed, so snapshots captured its error box. Re-render it from
  // the list it's bound to.
  for (const f of readdirSync(resolve(SITE_DIR, 'lists'))) {
    const l = JSON.parse(readFileSync(resolve(SITE_DIR, 'lists', f), 'utf8'));
    if (l.id) listsById.set(l.id.toLowerCase(), l);
  }
  for (const f of readdirSync(resolve(SITE_DIR, 'pages'))) {
    const p = JSON.parse(readFileSync(resolve(SITE_DIR, 'pages', f), 'utf8'));
    if (!p.CanvasContent1?.includes('Modern FAQ')) continue;
    const { document } = parseHTML(`<!doctype html><html><body>${p.CanvasContent1}</body></html>`);
    const configs = [...document.querySelectorAll('[data-sp-webpartdata]')]
      .map((e) => { try { return JSON.parse(e.getAttribute('data-sp-webpartdata')); } catch { return null; } })
      .filter((d) => d?.title === 'Modern FAQ')
      .map((d) => d.properties);
    faqConfigs.set(p.FileLeafRef.toLowerCase(), configs);
  }

  const livePath = resolve(SNAP_DIR, '_live-chrome.html');
  if (existsSync(livePath)) {
    const { document } = parseHTML(readFileSync(livePath, 'utf8'));
    const suite = document.querySelector('#SuiteNavWrapper');
    const header = document.querySelector('#spSiteHeader');
    // Editing affordances mean nothing in a read-only replica.
    header?.querySelectorAll('button, [data-automationid="SiteHeaderFollowButton"]').forEach((b) => {
      if (/Edit navigation|Site access|Follow|Not following|Share/i.test(b.textContent)) b.remove();
    });
    header?.querySelectorAll('a').forEach((a) => { if (/Edit navigation/i.test(a.textContent)) a.remove(); });
    // The capture shows whoever exported the site as signed in; show a neutral demo identity.
    const me = suite?.querySelector('#O365_MainLink_Me');
    if (me) {
      me.setAttribute('aria-label', 'Account manager');
      me.querySelectorAll('span').forEach((s) => { if (s.textContent.trim().length > 1) s.textContent = 'Demo User'; });
      const photo = me.querySelector('#O365_MainLink_MePhoto');
      if (photo) photo.querySelectorAll('div').forEach((d) => { if (d.children.length === 0 && d.textContent.trim().length <= 2) d.textContent = 'DU'; });
    }
    suite?.querySelector('#O365_MainLink_Signin')?.parentElement?.remove();
    chrome = {
      suiteNav: suite?.outerHTML || '',
      siteHeader: header?.outerHTML || '',
      css: [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n'),
    };
  }
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** FAQ accordion HTML from the web part's bound lists. */
function faqHtml(props) {
  const qs = listsById.get(String(props?.faqQuestionsList || '').toLowerCase());
  if (!qs) return null;
  const cats = listsById.get(String(props.faqCategoryList || '').toLowerCase());
  const catName = new Map((cats?.items || []).map((c) => [Number(c.Id ?? c.ID), c.Title]));
  const active = (v) => !(v === false || /^(false|no|0)$/i.test(String(v ?? '').trim()));
  const items = qs.items
    .filter((it) => active(it.IsActive) && it.Title)
    .sort((a, b) => (Number(a.Sequence) || 0) - (Number(b.Sequence) || 0));
  // Site-authored rich text; drop anything executable before inlining it.
  const safeHtml = (h) => String(h || '')
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
  const one = (it) => `<details class="bc-faq-item"><summary>${esc(it.Title)}</summary><div class="bc-faq-answer">${safeHtml(it.Answers)}</div></details>`;
  if (!props.displayCategories) return `<div class="bc-faq">${items.map(one).join('')}</div>`;
  const groups = new Map();
  for (const it of items) {
    const c = catName.get(Number(Array.isArray(it.CategoryId) ? it.CategoryId[0] : it.CategoryId)) || 'General';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  }
  return `<div class="bc-faq">${[...groups].map(([c, its]) => `<h3 class="bc-faq-cat">${esc(c)}</h3>${its.map(one).join('')}`).join('')}</div>`;
}

/** Map a link found in a page to where it should go in the replica. */
function rewriteHref(href) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return { href };
  let u;
  try { u = new URL(href, `${ORIGIN}${PREFIX}SitePages/Home.aspx`); } catch { return { href }; }
  if (u.origin !== ORIGIN) return { href, external: true };
  // Sharing links: /:b:/r/sites/BetterCare/... -> /sites/BetterCare/...
  let path = decodeURIComponent(u.pathname).replace(/^\/:[a-z]:\/[rs]\//i, '/');
  if (path.toLowerCase() === '/sites/bettercare' || path.toLowerCase() === '/sites/bettercare/') path = `${PREFIX}SitePages/Home.aspx`;
  if (path.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    const rel = path.slice(PREFIX.length);
    const page = /^SitePages\/([^/]+\.aspx)$/i.exec(rel);
    if (page && pages.has(page[1].toLowerCase())) return { href: encodeURI(path) + u.hash };
    if (existsSync(resolve(FILES_DIR, rel))) return { href: encodeURI(path) + u.hash };
  }
  // Not in the export (another site, a list form, a deleted page): go to the real thing.
  return { href: u.href, external: true };
}

function renderPage(name) {
  if (rendered.has(name)) return rendered.get(name);
  const html = readFileSync(pages.get(name), 'utf8');
  const { document } = parseHTML(html);

  // Graft the suite bar and site header in.
  if (chrome) {
    const suite = document.querySelector('#SuiteNavWrapper');
    if (suite && chrome.suiteNav) suite.outerHTML = chrome.suiteNav;
    const hub = document.querySelector('[data-automationid="AppChrome"] > div:nth-child(2)');
    if (hub && chrome.siteHeader && !document.querySelector('#spSiteHeader')) hub.insertAdjacentHTML('afterend', chrome.siteHeader);
  }

  const faqs = faqConfigs.get(name) || [];
  [...document.querySelectorAll('[data-sp-feature-tag^="FaqWebPart"]')].forEach((el, i) => {
    const html = faqHtml(faqs[i]);
    if (!html) return;
    el.innerHTML = html;
    // The failed web part was captured as an invisible, zero-height,
    // absolutely-positioned box (flexible sections position controls
    // absolutely); put it back in normal flow so it takes up space.
    for (let n = el; n && n.getAttribute('data-automation-id') !== 'CollapsibleLayer-Content' && n.getAttribute('data-automation-id') !== 'CanvasZone'; n = n.parentElement) {
      n.style.setProperty('height', 'auto', 'important');
      n.style.setProperty('min-height', '0', 'important');
      n.style.setProperty('opacity', '1', 'important');
      n.style.setProperty('position', 'static', 'important');
      n.style.setProperty('transform', 'none', 'important');
    }
  });

  // Other custom web parts that failed in the frame: hide the error box.
  for (const ctl of document.querySelectorAll('[data-automation-id="CanvasControl"]')) {
    if (/^\s*Something went wrong/.test(ctl.textContent)) ctl.style.display = 'none';
  }

  for (const a of document.querySelectorAll('a[href]')) {
    const { href, external } = rewriteHref(a.getAttribute('href'));
    a.setAttribute('href', href);
    if (external) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
    else { a.removeAttribute('target'); a.removeAttribute('data-interception'); }
  }
  for (const img of document.querySelectorAll('img[src]')) img.setAttribute('src', localImage(img.getAttribute('src')));
  for (const n of document.querySelectorAll('[style*="url("]')) {
    n.setAttribute('style', n.getAttribute('style').replace(/url\((['"]?)(https:[^'")]+)\1\)/g, (m, q, u) => `url(${q}${localImage(u)}${q})`));
  }

  // Leftover SharePoint iframes (embeds, video players) can't load without auth.
  document.querySelectorAll('iframe').forEach((f) => f.remove());

  const head = document.querySelector('head');
  head.insertAdjacentHTML('afterbegin', '<base href="/sites/BetterCare/SitePages/">');
  if (chrome?.css) head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/_replica/chrome.css">');
  head.insertAdjacentHTML('beforeend', `
    <link rel="stylesheet" href="/_replica/assistant.css">
    <script type="module" src="/_replica/assistant.js"></script>`);
  document.documentElement.setAttribute('data-bc-replica', '');

  const out = `<!doctype html>\n${document.documentElement.outerHTML}`;
  rendered.set(name, out);
  return out;
}

/** @returns {Promise<boolean>} true if handled */
export async function handle(req, res, url, { serveFile }) {
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return false; }

  if (path === '/' || path.toLowerCase() === '/sites/bettercare' || path.toLowerCase() === '/sites/bettercare/') {
    res.writeHead(302, { Location: `${PREFIX}SitePages/Home.aspx` }).end();
    return true;
  }

  // Replica support files: the assistant UI, grafted chrome CSS, nav data.
  if (path.startsWith('/_replica/')) {
    const rel = path.slice('/_replica/'.length);
    if (rel === 'chrome.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'max-age=3600' }).end(chrome?.css || '');
      return true;
    }
    // Auth-only images, captured by the exporter.
    if (rel.startsWith('remote/')) {
      const key = rel.slice('remote/'.length);
      const types = (() => { try { return JSON.parse(readFileSync(resolve(REMOTE_DIR, 'index.json'), 'utf8')); } catch { return {}; } })();
      return serveFile(req, res, REMOTE_DIR, key, { 'Content-Type': types[key] || 'image/png', 'Cache-Control': 'max-age=86400' });
    }
    // The list the exporter fetches to capture those images.
    if (rel === 'remote-list.json') {
      for (const name of pages.keys()) renderPage(name);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Private-Network': 'true' })
        .end(JSON.stringify([...remoteUrls].filter((u) => !existsSync(resolve(REMOTE_DIR, remoteKey(u))))));
      return true;
    }
    if (rel === 'site.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        title: siteJson?.web?.Title || 'BetterCare',
        nav: siteJson?.nav?.Nodes || [],
      }));
      return true;
    }
    return serveFile(req, res, HERE, rel, { 'Cache-Control': 'no-cache' });
  }

  if (path.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    const rel = path.slice(PREFIX.length);
    const page = /^SitePages\/([^/]+\.aspx)$/i.exec(rel);
    if (page) {
      const name = page[1].toLowerCase();
      if (!pages.has(name)) {
        const real = `${ORIGIN}${encodeURI(path)}`;
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Not in the replica</title>
<body style="font:15px 'Segoe UI',system-ui,sans-serif;max-width:560px;margin:80px auto;color:#242424">
<h2 style="font-weight:600">This page isn't in the local replica</h2>
<p>It wasn't part of the export (it may be a test page or live on another site).</p>
<p><a href="${real.replace(/"/g, '&quot;')}" style="color:#993E0C">Open it on SharePoint ↗</a> · <a href="/sites/BetterCare/SitePages/Home.aspx" style="color:#993E0C">Back to BetterCare home</a></p></body>`);
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderPage(name));
      return true;
    }
    // Captured page images (snapshots/assets) are referenced relative to SitePages/.
    const asset = /^SitePages\/assets\/([^/]+)$/i.exec(rel);
    if (asset) return serveFile(req, res, resolve(SNAP_DIR, 'assets'), asset[1], { 'Cache-Control': 'max-age=86400' });
    return serveFile(req, res, FILES_DIR, rel);
  }
  return false;
}
