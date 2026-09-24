// Full read-only export of the BetterCare SharePoint site.
//
// Paste into DevTools on any page of the site while signed in (or inject it),
// with `node tools/export-receiver.mjs` running on the same machine. Every
// SharePoint request is an HTTP GET; the only writes go to the local receiver.
//
//   await bcExport.run()                  // everything
//   await bcExport.run({ phases: ['pages'] })
//   bcExport.state                        // progress
//
// Output (data/site/):
//   site.json                  web + navigation
//   lists/<list>.json          every visible list: schema + all items
//   pages/<page>.json          Site Pages items incl. CanvasContent1 (web part layout)
//   files.json                 manifest of every file in every document library
//   files/<server path>        the files themselves
//   snapshots/<page>.html      each page as rendered, with its CSS inlined

(() => {
  const SITE = 'https://uthealthsa.sharepoint.com/sites/BetterCare';
  const SITE_PATH = '/sites/BetterCare';
  const RX = 'http://127.0.0.1:8799';
  const H = { headers: { Accept: 'application/json;odata=nometadata' } };

  // Bump when snapshot capture changes, so re-runs redo only older captures.
  const SNAPSHOT_VERSION = '2';

  const state = { phase: null, done: 0, total: 0, bytes: 0, errors: [], log: [] };

  const log = (msg) => {
    state.log.push(msg);
    fetch(`${RX}/log`, { method: 'PUT', body: msg }).catch(() => {});
  };

  async function get(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, H);
      // Throttling arrives either as 429/503 or as a 200 HTML error page.
      const throttled = res.status === 429 || res.status >= 500
        || (res.ok && !String(res.headers.get('content-type')).includes('json'));
      if (res.ok && !throttled) return res.json();
      if (throttled && attempt < 8) {
        state.throttled = (state.throttled || 0) + 1;
        await sleep(Math.min(60, Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000);
        continue;
      }
      throw new Error(`${res.status} ${url}`);
    }
  }

  /** Follow OData paging. */
  async function all(url) {
    const out = [];
    while (url) {
      const d = await get(url);
      out.push(...(d.value || []));
      url = d['odata.nextLink'] || null;
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);

  async function put(path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${RX}/put?path=${encodeURIComponent(path)}`, { method: 'PUT', body });
        if (res.ok) return;
        throw new Error(`receiver ${res.status}`);
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  const putJson = (path, obj) => put(path, JSON.stringify(obj, null, 1));

  /** Run fn over items with bounded concurrency. */
  async function pool(items, n, fn, counter = state) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try { await fn(item); } catch (e) { state.errors.push(`${e.message}`); log(`ERROR ${e.message}`); }
        counter.done++;
      }
    }));
  }

  // ------------------------------------------------------------ phases

  async function site() {
    const web = await get(`${SITE}/_api/web?$select=Title,Url,Description,SiteLogoUrl,Created,LastItemModifiedDate`);
    const menu = async (p) => {
      try { return await get(`${SITE}/_api/navigation/menustate?mapprovidername='${p}'`); } catch { return null; }
    };
    const hub = await get(`${SITE}/_api/web/hubsitedata(false)`).catch(() => null);
    await putJson('site.json', {
      exportedAt: new Date().toISOString(),
      web,
      nav: await menu('CurrentNavigationSwitchableProvider'),
      globalNav: await menu('GlobalNavigationSwitchableProvider'),
      hub: hub?.value ? JSON.parse(hub.value) : hub,
    });
    log('site.json written');
  }

  async function lists() {
    const ls = await all(`${SITE}/_api/web/lists?$select=Title,Id,BaseTemplate,ItemCount,Hidden,Description,RootFolder/ServerRelativeUrl&$expand=RootFolder&$filter=Hidden eq false`);
    state.total = ls.length; state.done = 0;
    await pool(ls, 3, async (l) => {
      const fields = await all(`${SITE}/_api/web/lists(guid'${l.Id}')/fields?$select=Title,InternalName,TypeAsString,Hidden&$filter=Hidden eq false`);
      const items = await all(`${SITE}/_api/web/lists(guid'${l.Id}')/items?$top=500`);
      await putJson(`lists/${safe(l.Title)}.json`, { list: l.Title, id: l.Id, baseTemplate: l.BaseTemplate, root: l.RootFolder?.ServerRelativeUrl, description: l.Description, fields, items });
    });
    log(`lists: ${ls.length} written`);
  }

  async function pages() {
    const sel = 'Id,Title,FileRef,FileLeafRef,Description,BannerImageUrl,PromotedState,FirstPublishedDate,Modified,Created,CanvasContent1,LayoutWebpartsContent,OData__AuthorBylineId,PageLayoutType';
    let items;
    try {
      items = await all(`${SITE}/_api/web/lists/getbytitle('Site Pages')/items?$select=${sel}&$top=200`);
    } catch {
      items = await all(`${SITE}/_api/web/lists/getbytitle('Site Pages')/items?$select=Id,Title,FileRef,FileLeafRef,Description,BannerImageUrl,PromotedState,FirstPublishedDate,Modified,CanvasContent1,LayoutWebpartsContent&$top=200`);
    }
    state.total = items.length; state.done = 0;
    await pool(items, 4, (p) => putJson(`pages/${safe(p.FileLeafRef.replace(/\.aspx$/i, ''))}.json`, p));
    log(`pages: ${items.length} written`);
    return items;
  }

  async function manifest() {
    const libs = await all(`${SITE}/_api/web/lists?$select=Title,Id,BaseTemplate&$filter=BaseTemplate eq 101 or BaseTemplate eq 109 or BaseTemplate eq 119`);
    const files = [];
    for (const l of libs) {
      const items = await all(`${SITE}/_api/web/lists(guid'${l.Id}')/items?$select=Id,FileRef,FileLeafRef,FSObjType,Modified,File/Length,File/ETag&$expand=File&$top=2000`);
      for (const it of items) {
        if (it.FSObjType !== 0) continue;
        files.push({ library: l.Title, id: it.Id, path: it.FileRef, name: it.FileLeafRef, size: Number(it.File?.Length) || 0, etag: it.File?.ETag, modified: it.Modified });
      }
    }
    await putJson('files.json', files);
    log(`files.json: ${files.length} files, ${(files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(0)} MB`);
    return files;
  }

  async function files(list) {
    list ||= await manifest();
    // Page files are exported as JSON + snapshots; the .aspx bytes SharePoint
    // serves are a rendered shell whose size never matches the manifest.
    list = list.filter((f) => f.library !== 'Site Pages');
    // Small files first so the text-bearing documents land early.
    list = [...list].sort((a, b) => a.size - b.size);
    state.total = list.length; state.done = 0;
    await pool(list, 2, async (f) => {
      const local = `files/${f.path.replace(SITE_PATH + '/', '')}`;
      const have = await fetch(`${RX}/has?path=${encodeURIComponent(local)}`).then((r) => r.json()).catch(() => ({ size: -1 }));
      if (have.size === f.size && f.size > 0) return;           // resumable
      // SharePoint throttles bulk downloads with a 200 OK *HTML error page*
      // (throttleerror.js), not a 429. The manifest size is the check.
      let blob;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://uthealthsa.sharepoint.com${encodeURI(f.path).replace(/#/g, '%23')}`);
        if (res.ok) {
          blob = await res.blob();
          // Office files are re-stamped with metadata on download, so their size
          // legitimately differs; only an HTML body for a non-HTML file is a throttle page.
          const html = blob.type.includes('text/html') && !/\.html?$/i.test(f.name);
          if (blob.size === f.size || !f.size || (!html && /\.(docx|xlsx|pptx|doc|xls|ppt)$/i.test(f.name))) break;
        } else if (res.status !== 429 && res.status < 500) {
          throw new Error(`${res.status} ${f.path}`);
        }
        if (attempt >= 6) throw new Error(`throttled/size mismatch ${f.path} (${blob?.size} vs ${f.size})`);
        state.throttled = (state.throttled || 0) + 1;
        await sleep(Math.min(60000, 2000 * 2 ** attempt));
      }
      await put(local, blob);
      state.bytes += blob.size;
    });
    log(`files: done, ${(state.bytes / 1e6).toFixed(0)} MB transferred, ${state.errors.length} errors`);
  }

  /** Collect the CSS a rendered document is using, including CSSOM-injected rules. */
  function collectCss(doc) {
    const parts = [];
    const external = [];
    for (const sheet of doc.styleSheets) {
      try {
        parts.push([...sheet.cssRules].map((r) => r.cssText).join('\n'));
      } catch {
        if (sheet.href) external.push(sheet.href);        // cross-origin; fetched later by node
      }
    }
    return { css: parts.join('\n'), external };
  }

  const assetCache = new Map();

  /** Download an image once and return its path relative to a snapshot. */
  async function localAsset(src, win) {
    if (!src || src.startsWith('data:')) return src;
    if (assetCache.has(src)) return assetCache.get(src);
    const job = (async () => {
      try {
        const res = await win.fetch(src, { credentials: 'include' });
        if (!res.ok) return src;
        const blob = await res.blob();
        const buf = await blob.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', buf))]
          .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
        const ext = (blob.type.split('/')[1] || 'bin').replace('svg+xml', 'svg').replace('jpeg', 'jpg').split(';')[0];
        const name = `${hash}.${ext}`;
        const have = await fetch(`${RX}/has?path=${encodeURIComponent(`snapshots/assets/${name}`)}`).then((r) => r.json()).catch(() => ({ size: -1 }));
        if (have.size !== blob.size) await put(`snapshots/assets/${name}`, blob);
        return `assets/${name}`;
      } catch {
        return src;
      }
    })();
    assetCache.set(src, job);
    return job;
  }

  async function snapshot(p) {
    const frame = document.createElement('iframe');
    // On-screen (but invisible): SharePoint renders canvas sections lazily via
    // IntersectionObserver, which never fires for an off-screen frame. The tab
    // itself must also be the active tab, or Chrome throttles rendering.
    frame.style.cssText = 'position:fixed;left:0;top:0;width:1440px;height:1000px;border:0;opacity:0;pointer-events:none;z-index:-1;';
    frame.src = `https://uthealthsa.sharepoint.com${encodeURI(p.FileRef)}`;
    document.body.append(frame);
    try {
      await new Promise((resolve, reject) => {
        frame.onload = resolve;
        setTimeout(() => reject(new Error(`load timeout ${p.FileLeafRef}`)), 60000);
      });
      const doc = frame.contentDocument;
      // Wait for the modern page canvas to render, then scroll to trigger lazy web parts.
      for (let i = 0; i < 40 && !doc.querySelector('[data-automation-id="CanvasZone"], .CanvasZone'); i++) await sleep(500);
      const win = frame.contentWindow;
      // Scroll through the page until every authored control has rendered
      // (count known from CanvasContent1) or the page stops growing.
      const expected = (p.CanvasContent1?.match(/data-sp-canvascontrol/g) || []).length;
      const count = () => doc.querySelectorAll('[data-automation-id="CanvasControl"]').length;
      // Collapsible sections don't render their web parts until expanded.
      for (let round = 0; round < 4; round++) {
        const closed = [...doc.querySelectorAll('[data-automation-id="CollapsibleLayer-Button"][aria-expanded="false"]')];
        if (!closed.length) break;
        closed.forEach((b) => { b.setAttribute('data-bc-was-collapsed', ''); b.click(); });
        await sleep(1200);
      }
      const scroller = doc.querySelector('[data-automation-id="contentScrollRegion"]')?.closest('[data-is-scrollable="true"]')
        || doc.querySelector('[data-is-scrollable="true"]') || doc.scrollingElement;
      let stable = 0, last = -1;
      for (let step = 0; step < 80 && stable < 6; step++) {
        scroller.scrollTop += 500; win.scrollBy(0, 500);
        await sleep(300);
        const n = count();
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        stable = n === last && (atBottom || n >= expected) ? stable + 1 : 0;
        last = n;
      }
      scroller.scrollTop = 0; win.scrollTo(0, 0);
      await sleep(1500);
      state.snapQuality ||= [];
      state.snapQuality.push({ page: p.FileLeafRef, expected, rendered: count() });

      const { css, external } = collectCss(doc);
      const clone = doc.documentElement.cloneNode(true);
      clone.querySelectorAll('script, noscript, iframe[src*="about:blank"], link[rel="preload"], link[rel="prefetch"]').forEach((n) => n.remove());
      // Freeze lazy images to what was actually displayed, and save them
      // locally: SharePoint serves most images as short-lived blob: URLs or
      // auth-only thumbnail endpoints, neither of which works offline.
      const live = [...doc.images];
      const imgs = [...clone.querySelectorAll('img')];
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        const src = live[i]?.currentSrc || img.getAttribute('src');
        img.removeAttribute('srcset'); img.removeAttribute('loading');
        if (src) img.setAttribute('src', await localAsset(src, win));
      }
      for (const n of clone.querySelectorAll('[style*="url("]')) {
        let style = n.getAttribute('style');
        for (const m of [...style.matchAll(/url\((['"]?)([^'")]+)\1\)/g)]) {
          style = style.replace(m[2], await localAsset(m[2], win));
        }
        n.setAttribute('style', style);
      }
      const style = doc.createElement('style');
      style.setAttribute('data-bc-inlined', '');
      style.textContent = css;
      clone.querySelector('head').append(style);
      const ver = doc.createElement('meta');
      ver.setAttribute('name', 'bc-snapshot-version');
      ver.setAttribute('content', SNAPSHOT_VERSION);
      clone.querySelector('head').append(ver);
      const meta = doc.createElement('meta');
      meta.setAttribute('name', 'bc-external-css');
      meta.setAttribute('content', JSON.stringify(external));
      clone.querySelector('head').append(meta);

      await put(`snapshots/${safe(p.FileLeafRef.replace(/\.aspx$/i, ''))}.html`, `<!doctype html>\n${clone.outerHTML}`);
    } finally {
      frame.remove();
    }
  }

  async function snapshots(items, { skipExisting = true } = {}) {
    items ||= await all(`${SITE}/_api/web/lists/getbytitle('Site Pages')/items?$select=Id,FileRef,FileLeafRef,CanvasContent1&$top=200`);
    items = items.filter((p) => /\.aspx$/i.test(p.FileLeafRef));
    state.snap = { done: 0, total: items.length };
    await pool(items, 2, async (p) => {
      if (skipExisting) {
        const name = `snapshots/${safe(p.FileLeafRef.replace(/\.aspx$/i, ''))}.html`;
        const marker = `name="bc-snapshot-version" content="${SNAPSHOT_VERSION}"`;
        const have = await fetch(`${RX}/has?path=${encodeURIComponent(name)}&marker=${encodeURIComponent(marker)}`).then((r) => r.json()).catch(() => ({ size: -1 }));
        if (have.size > 0 && have.marker) return;
      }
      await snapshot(p);
    }, state.snap);
    log(`snapshots: ${items.length} pages`);
  }

  /**
   * Capture images the replica still references on auth-only hosts (the site
   * logo, list-image thumbnails). The replica server lists what it needs.
   *   await bcExport.remoteAssets()        // with `npm start` running
   */
  async function remoteAssets(replica = 'http://localhost:8787') {
    const urls = await (await fetch(`${replica}/_replica/remote-list.json`)).json();
    const types = {};
    state.remote = { done: 0, total: urls.length, failed: 0 };
    await pool(urls, 4, async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) { state.remote.failed++; return; }
      const key = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(u)))]
        .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
      types[key] = type.split(';')[0];
      await put(`remote/${key}`, await res.blob());
    }, state.remote);
    // Merge with any earlier run's content types.
    const prev = await fetch(`${replica}/_replica/remote/index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    await putJson('remote/index.json', { ...prev, ...types });
    log(`remote assets: ${Object.keys(types).length} saved, ${state.remote.failed} failed`);
    return state.remote;
  }

  async function run({ phases = ['site', 'lists', 'pages', 'files', 'snapshots'], only } = {}) {
    const started = Date.now();
    let pageItems;
    for (const ph of phases) {
      state.phase = ph; state.done = 0; state.total = 0;
      log(`phase ${ph}…`);
      if (ph === 'site') await site();
      if (ph === 'lists') await lists();
      if (ph === 'pages') pageItems = await pages();
      if (ph === 'files') await files();
      if (ph === 'snapshots') await snapshots(only ? pageItems?.filter((p) => only.includes(p.FileLeafRef)) : pageItems);
    }
    state.phase = 'done';
    log(`export finished in ${((Date.now() - started) / 60000).toFixed(1)} min, ${state.errors.length} errors`);
    return state;
  }

  window.bcExport = { run, state, snapshot, manifest, files, snapshots, remoteAssets };
})();
