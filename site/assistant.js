// Sophia Assistant, integrated into the site replica.
//
// What an SPFx integration on the real site would provide:
//   - a Copilot-style pane on every page (suite-bar button + floating launcher)
//   - the "Search this site" box upgraded: live semantic results as you type,
//     Enter asks the assistant; a toggle shows what classic keyword search finds
//   - citations that open the cited page and highlight the exact passage
//   - working dropdowns for the site navigation
//
// The conversation lives in sessionStorage, so the pane stays open with its
// history when a citation navigates to another page.

import { streamChat, searchApi, health } from '/lib/chat-api.js';
import { renderAnswer } from '/lib/render.js';

const API = location.origin;
const STORE = 'bc-assistant-v1';

const SUGGESTIONS = [
  'How do I set up Haiku on my phone?',
  'When is the next Epic upgrade?',
  'How do I get access to Abridge?',
  'Where is the cash drawer tip sheet?',
  'Who do I contact for Epic help?',
];

const KIND = {
  page: ['PG', '--bc-k-page', 'Page'], news: ['NEWS', '--bc-k-news', 'News'], faq: ['FAQ', '--bc-k-faq', 'FAQ'],
  document: ['PDF', '--bc-k-document', 'Document'], slides: ['PPT', '--bc-k-slides', 'Slides'],
  spreadsheet: ['XLS', '--bc-k-spreadsheet', 'Spreadsheet'], event: ['EVT', '--bc-k-event', 'Event'],
  feature: ['EPIC', '--bc-k-feature', 'Epic feature'], catalog: ['TIP', '--bc-k-catalog', 'Tip sheet'],
  glossary: ['TERM', '--bc-k-glossary', 'Glossary'], resource: ['RES', '--bc-k-resource', 'Resource'],
  announcement: ['NEW', '--bc-k-news', 'Announcement'], directory: ['DIR', '--bc-k-resource', 'Directory'],
  file: ['FILE', '--bc-k-file', 'File'],
};

const ICON = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
};

// ---------------------------------------------------------------- utilities

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'svg') n.innerHTML = v;            // static icon markup only
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

function kindIcon(kind) {
  const [abbr, color] = KIND[kind] || KIND.page;
  return el('span', { class: 'bc-kind-ico', style: `--k: var(${color})`, text: abbr, 'aria-hidden': 'true' });
}

const kindLabel = (k) => (KIND[k] || [null, null, k])[2];

function load() {
  try { return JSON.parse(sessionStorage.getItem(STORE)) || { open: false, turns: [] }; } catch { return { open: false, turns: [] }; }
}
function save() {
  try { sessionStorage.setItem(STORE, JSON.stringify({ open: state.open, turns: state.turns.filter((t) => !t.pending) })); } catch { /* private mode */ }
}

const state = load();
let busy = false;
let ctl = null;
let mode = null;

// ---------------------------------------------------------------- navigation to a source

/** Where a citation goes: the local page (highlighting the passage) or the file. */
function sourceHref(s) {
  if (!s.localUrl) return { href: s.url, external: true };
  if (s.sourceType === 'document') return { href: s.localUrl, external: true };
  const hl = { h: s.headingPath?.[s.headingPath.length - 1] || null, t: s.snippet?.slice(0, 90), title: s.title, list: s.sourceType === 'list-item' };
  return { href: `${s.localUrl.split('#')[0]}#bc-hl=${encodeURIComponent(JSON.stringify(hl))}`, external: false };
}

function openSource(s, e) {
  const { href, external } = sourceHref(s);
  if (external) return;                       // plain link, new tab
  e?.preventDefault();
  const target = new URL(href, location.href);
  if (target.pathname === location.pathname) {
    history.replaceState(null, '', target.hash);
    highlightFromHash();
  } else {
    save();
    location.href = target.href;
  }
}

// ---------------------------------------------------------------- pane

let pane, thread, input, sendBtn, footMode;

function mountPane() {
  thread = el('div', { class: 'bc-thread', 'aria-live': 'polite' });
  input = el('textarea', { rows: '1', placeholder: 'Ask about Epic, Abridge, training, upgrades…', 'aria-label': 'Ask Sophia' });
  sendBtn = el('button', { class: 'bc-send', type: 'submit', 'aria-label': 'Send', svg: ICON.send, disabled: '' });
  footMode = el('span', { text: 'Answers from BetterCare content only' });

  const form = el('form', { class: 'bc-composer' }, [
    el('div', { class: 'bc-field' }, [input, sendBtn]),
    el('div', { class: 'bc-foot' }, [footMode, el('span', { text: 'Shift+Enter for a new line' })]),
  ]);

  pane = el('aside', { class: 'bc-pane', role: 'complementary', 'aria-label': 'Sophia Assistant' }, [
    el('div', { class: 'bc-head' }, [
      el('div', { class: 'bc-mark', svg: ICON.spark }),
      el('div', { class: 'bc-title' }, [el('b', { text: 'Sophia Assistant' }), el('span', { text: 'Searches every page, list and document on BetterCare' })]),
      el('button', { class: 'bc-icon-btn', type: 'button', title: 'New conversation', 'aria-label': 'New conversation', svg: ICON.plus, onclick: reset }),
      el('button', { class: 'bc-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close Sophia', svg: ICON.close, onclick: () => setOpen(false) }),
    ]),
    thread,
    form,
  ]);

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    if (!busy) sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { ctl?.abort(); return; }
    const q = input.value.trim();
    if (!q) return;
    input.value = ''; input.style.height = 'auto';
    ask(q);
  });

  document.body.append(pane);
  document.body.append(el('button', { class: 'bc-launcher', type: 'button', svg: `${ICON.spark}<span>Ask Sophia</span>`, onclick: () => setOpen(true) }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open && !document.querySelector('.bc-search-pop:not([hidden])')) setOpen(false); });
}

function setOpen(open) {
  state.open = open;
  document.documentElement.toggleAttribute('data-bc-pane-open', open);
  save();
  if (open) setTimeout(() => input.focus(), 50);
}

function reset() {
  ctl?.abort();
  state.turns = [];
  save();
  renderThread();
  input.focus();
}

function renderThread() {
  thread.replaceChildren();
  if (!state.turns.length) {
    thread.append(el('div', { class: 'bc-welcome' }, [
      el('h2', { text: "Hi, I'm Sophia. What are you looking for?" }),
      el('p', { text: 'Ask in your own words. I search every page, list, tip sheet and document on BetterCare and answer with links to the exact source.' }),
      el('div', { class: 'bc-suggests' }, SUGGESTIONS.map((q) => el('button', { class: 'bc-suggest', type: 'button', text: q, onclick: () => ask(q) }))),
    ]));
    return;
  }
  for (const t of state.turns) thread.append(t.role === 'user' ? userTurn(t.content) : assistantTurn(t).node);
  thread.scrollTop = thread.scrollHeight;
}

function userTurn(text) {
  return el('div', { class: 'bc-turn bc-turn--user' }, [el('div', { class: 'bc-bubble', text })]);
}

/** Build (or rebuild) an assistant turn's DOM from its state. */
function assistantTurn(t) {
  const node = el('div', { class: 'bc-turn' });
  const answer = el('div', { class: 'bc-answer' });
  const status = el('div', { class: 'bc-status' }, [el('span', { class: 'bc-dots' }, [el('i'), el('i'), el('i')]), el('span', { text: '' })]);
  const sources = el('div', { class: 'bc-sources' });
  node.append(status, answer, sources);

  const cite = (n) => {
    const s = t.sources?.[n - 1];
    if (!s) return null;
    const { href, external } = sourceHref(s);
    return el('a', {
      class: 'bc-cite', href, title: s.title, text: String(n),
      target: external ? '_blank' : null, rel: external ? 'noopener' : null,
      onclick: (e) => openSource(s, e),
    });
  };

  const paint = () => {
    status.hidden = !t.pending || !!t.content;
    status.lastChild.textContent = t.status || 'Thinking…';
    answer.classList.toggle('bc-streaming', !!t.pending && !!t.content);
    answer.replaceChildren(renderAnswer(t.content || '', cite));
    // Links to BetterCare pages/files open here in the replica, not on SharePoint.
    for (const a of answer.querySelectorAll('a[href^="https://uthealthsa.sharepoint.com/sites/BetterCare"]')) {
      const l = localize(a.href);
      if (l && !l.external) { a.href = l.href; a.removeAttribute('target'); }
    }
    sources.replaceChildren();
    if (t.error) {
      sources.append(el('div', { class: 'bc-notice bc-notice--error' }, [
        t.error.message,
        t.retry ? el('button', { type: 'button', text: 'Retry', onclick: () => retry(t) }) : null,
      ]));
    }
    if (!t.pending && t.sources?.length) {
      const cited = new Set([...(t.content || '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim()))));
      const shown = t.sources.filter((s) => cited.has(s.n));
      const rest = t.sources.filter((s) => !cited.has(s.n));
      const list = el('div', { class: 'bc-sources' }, (shown.length ? shown : t.sources.slice(0, 4)).map(sourceCard));
      sources.append(list);
      const more = shown.length ? rest : t.sources.slice(4);
      if (more.length) {
        const extra = el('div', { class: 'bc-sources', hidden: '' }, more.map(sourceCard));
        const btn = el('button', { class: 'bc-sources-toggle', type: 'button', text: `More results (${more.length})`, onclick: () => { extra.hidden = !extra.hidden; btn.textContent = extra.hidden ? `More results (${more.length})` : 'Fewer results'; } });
        sources.append(btn, extra);
      }
    }
  };
  paint();
  return { node, paint };
}

function sourceCard(s) {
  const { href, external } = sourceHref(s);
  const where = [kindLabel(s.kind), s.headingPath?.filter(Boolean).join(' › ') || s.list, s.date].filter(Boolean).join(' · ');
  const card = el('a', {
    class: 'bc-src', href, target: external ? '_blank' : null, rel: external ? 'noopener' : null,
    onclick: (e) => openSource(s, e),
  }, [
    el('span', { class: 'bc-src-n', text: String(s.n) }),
    kindIcon(s.kind),
    el('span', { class: 'bc-src-body' }, [
      el('b', { text: s.title }),
      el('small', { text: where }),
    ]),
  ]);
  if (!s.docUrl) return card;
  return el('div', {}, [card, el('a', { class: 'bc-src-ext', href: s.docUrl, target: '_blank', rel: 'noopener', text: 'Open linked document ↗' })]);
}

const STAGES = { rewriting: 'Understanding your question…', retrieving: 'Searching BetterCare…', generating: 'Writing an answer…' };

async function ask(question) {
  if (busy) return;
  if (!state.open) setOpen(true);
  if (!state.turns.length) thread.replaceChildren();

  state.turns.push({ role: 'user', content: question });
  thread.append(userTurn(question));
  const t = { role: 'assistant', content: '', pending: true, status: 'Thinking…', sources: [] };
  state.turns.push(t);
  const view = assistantTurn(t);
  thread.append(view.node);
  thread.scrollTop = thread.scrollHeight;
  await stream(t, view);
}

async function stream(t, view) {
  busy = true;
  sendBtn.disabled = false;
  sendBtn.innerHTML = ICON.stop;
  sendBtn.setAttribute('aria-label', 'Stop');
  ctl = new AbortController();

  const history = state.turns
    .filter((x) => x !== t && !x.error)
    .map((x) => ({ role: x.role, content: x.content }))
    .filter((x) => x.content);

  let frame = 0;
  const repaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0; view.paint();
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    });
  };

  await streamChat(API, history, {
    status: (d) => { t.status = STAGES[d.stage] || t.status; repaint(); },
    sources: (s) => { t.sources = s; repaint(); },
    token: (d) => { t.content += d.text; repaint(); },
    reset: () => { t.content = ''; repaint(); },
    error: (e) => {
      t.error = e.code === 'UNREACHABLE' ? { message: "Can't reach the assistant server. Is `npm start` running?" }
        : e.code === 'RATE_LIMITED' ? { message: e.message || 'Too many questions — wait a moment.' }
        : { message: e.message || 'Something went wrong.' };
      t.retry = e.code !== 'REFUSED';
    },
    done: (d) => { t.meta = { mode: d.mode, model: d.model, latencyMs: d.latencyMs }; },
  }, ctl.signal);

  if (ctl.signal.aborted && !t.content) t.error = { message: 'Stopped.' };
  t.pending = false;
  busy = false;
  ctl = null;
  sendBtn.innerHTML = ICON.send;
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.disabled = !input.value.trim();
  view.paint();
  save();
}

function retry(t) {
  const i = state.turns.indexOf(t);
  const q = state.turns[i - 1]?.content;
  state.turns.splice(i - 1, 2);
  renderThread();
  if (q) ask(q);
}

// ---------------------------------------------------------------- search box

function hookSearch() {
  const box = document.querySelector('#sbcId input, input[placeholder="Search this site"]');
  if (!box) return;
  box.placeholder = 'Search or ask Sophia';
  box.removeAttribute('readonly');
  box.closest('form')?.addEventListener('submit', (e) => e.preventDefault());
  // SharePoint's own styles keep the inactive box narrow and dim; make it look live.
  box.closest('#sbcId')?.classList.remove('o365sx-searchBoxInactive');

  const pop = el('div', { class: 'bc-search-pop', hidden: '', role: 'listbox' });
  document.body.append(pop);

  let timer = null, seq = 0, items = [], active = -1, classicOpen = false;

  const place = () => {
    const r = box.closest('form')?.getBoundingClientRect() || box.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - pop.offsetWidth - 12))}px`;
  };

  const close = () => { seq++; clearTimeout(timer); pop.hidden = true; active = -1; };

  const submit = (q) => {
    close();
    box.value = '';
    box.blur();
    ask(q);
  };

  const render = (q, data, classic) => {
    items = [];
    pop.replaceChildren();
    const askBtn = el('button', { class: 'bc-sp-ask', type: 'button', onclick: () => submit(q) }, [
      el('span', { svg: ICON.spark, style: 'display:contents' }),
      el('span', {}, ['Ask Sophia: ', el('b', { text: q })]),
      el('kbd', { text: 'Enter' }),
    ]);
    items.push(askBtn);
    pop.append(askBtn);

    if (data) {
      pop.append(el('div', { class: 'bc-sp-label' }, ['Top matches on this site', el('span', { text: `${data.ms} ms · meaning + keywords` })]));
      if (!data.results.length) pop.append(el('div', { class: 'bc-sp-empty', text: 'No matches.' }));
      for (const s of data.results.slice(0, 6)) {
        const { href, external } = sourceHref(s);
        const a = el('a', {
          class: 'bc-sp-item', href, target: external ? '_blank' : null, rel: external ? 'noopener' : null,
          onclick: (e) => { close(); openSource(s, e); },
        }, [kindIcon(s.kind), el('span', {}, [el('b', { text: s.title }), el('small', { text: s.snippet })])]);
        items.push(a);
        pop.append(a);
      }
    } else {
      pop.append(el('div', { class: 'bc-sp-empty', text: 'Searching…' }));
    }

    if (classicOpen) {
      pop.append(el('div', { class: 'bc-classic' }, [
        el('h5', { text: 'Classic keyword search (exact words, no understanding)' }),
        classic == null ? el('p', { text: 'Searching…' })
          : !classic.results.length ? el('p', { text: `0 results for "${q}". Every word has to appear exactly as typed.` })
            : el('ol', {}, classic.results.slice(0, 5).map((r) => el('li', { text: r.title }))),
      ]));
    }

    pop.append(el('div', { class: 'bc-sp-foot' }, [
      el('span', { text: '↑↓ to move · Enter to ask · Esc to close' }),
      el('button', {
        type: 'button', text: classicOpen ? 'Hide classic search' : 'Compare with classic search',
        onclick: (e) => { e.stopPropagation(); classicOpen = !classicOpen; run(true); },
      }),
    ]));
    pop.hidden = false;
    place();
  };

  const run = async (immediate) => {
    const q = box.value.trim();
    clearTimeout(timer);
    if (!q) { close(); return; }
    const go = async () => {
      const my = ++seq;
      if (pop.hidden) render(q, null, null);
      const [data, classic] = await Promise.all([
        searchApi(API, q, 8).catch(() => ({ results: [], ms: 0 })),
        classicOpen ? fetch(`${API}/api/classic-search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ results: [] })) : null,
      ]);
      if (my === seq && box.value.trim() === q) render(q, data, classic);
    };
    if (immediate) go(); else timer = setTimeout(go, 180);
  };

  box.addEventListener('input', () => run(false));
  box.addEventListener('focus', () => { if (box.value.trim()) run(true); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); box.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (pop.hidden) return;
      items[active]?.classList.remove('bc-active');
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[active]?.classList.add('bc-active');
      items[active]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (active > 0) items[active].click();
      else if (box.value.trim()) submit(box.value.trim());
    }
  });
  document.addEventListener('mousedown', (e) => { if (!pop.contains(e.target) && e.target !== box) close(); });
  addEventListener('resize', () => { if (!pop.hidden) place(); });
}

// ---------------------------------------------------------------- suite bar button

function mountSuiteButton() {
  const region = document.querySelector('#O365_HeaderRightRegion');
  if (!region) return;
  region.prepend(el('button', { class: 'bc-suite-btn', type: 'button', svg: `${ICON.spark}<span>Ask Sophia</span>`, onclick: () => setOpen(!state.open) }));
}

// ---------------------------------------------------------------- site navigation menus

function localize(url) {
  if (!url || url === 'http://linkless.header/') return null;
  try {
    const u = new URL(url, location.origin);
    if (u.hostname === 'uthealthsa.sharepoint.com' && u.pathname.toLowerCase().startsWith('/sites/bettercare')) return { href: u.pathname + u.hash, external: false };
    if (u.origin === location.origin) return { href: u.pathname + u.hash, external: false };
    return { href: u.href, external: true };
  } catch { return null; }
}

async function mountNavMenus() {
  let nav;
  try { nav = (await (await fetch('/_replica/site.json')).json()).nav; } catch { return; }
  const top = nav.filter((n) => !n.IsHidden && n.Title !== 'Recent');
  const header = document.querySelector('#spSiteHeader');
  if (!header) return;

  let menu = null, hideTimer = null;
  const hide = () => { menu?.remove(); menu = null; };

  // The header was captured on the home page, so "Home" is marked current.
  // Mark the top-level item whose tree contains this page instead.
  const here = decodeURIComponent(location.pathname).toLowerCase();
  const pathOf = (n) => { const l = localize(n.SimpleUrl); return l && !l.external ? decodeURIComponent(l.href.split(/[?#]/)[0]).toLowerCase() : null; };
  const contains = (n) => pathOf(n) === here || (n.Nodes || []).some(contains);
  const homePage = here.endsWith('/sitepages/home.aspx');
  const current = homePage ? top.find((n) => n.Title === 'Home') : top.find((n) => n.Title !== 'Home' && contains(n));
  for (const span of header.querySelectorAll('.ms-HorizontalNavItem-linkText')) {
    const on = span.textContent.trim() === current?.Title;
    span.classList.toggle('is-selected', on);
    span.classList.toggle('is-not-selected', !on);
    for (const c of [...span.classList]) {
      if (/^linkSelected-/.test(c) && !on) { span.classList.remove(c); span.classList.add(c.replace('linkSelected', 'linkUnselected').replace(/\d+$/, (d) => String(Number(d) - 1))); }
      else if (/^linkUnselected-/.test(c) && on) { span.classList.remove(c); span.classList.add(c.replace('linkUnselected', 'linkSelected').replace(/\d+$/, (d) => String(Number(d) + 1))); }
    }
    const a = span.closest('a');
    if (a) { if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  }

  for (const a of header.querySelectorAll('a, button')) {
    const title = a.textContent.trim();
    const node = top.find((n) => n.Title === title);
    if (!node) continue;
    const loc = localize(node.SimpleUrl);
    if (a.tagName === 'A') {
      if (loc) { a.setAttribute('href', loc.href); if (loc.external) a.target = '_blank'; } else a.removeAttribute('href');
    } else if (loc && !node.Nodes?.length) {
      a.addEventListener('click', () => { location.href = loc.href; });
    }
    if (!node.Nodes?.length) continue;

    const open = () => {
      clearTimeout(hideTimer);
      hide();
      const r = a.getBoundingClientRect();
      menu = el('div', { class: 'bc-navmenu', role: 'menu' });
      const add = (n, depth) => {
        const l = localize(n.SimpleUrl);
        if (!l && n.Nodes?.length) menu.append(el('div', { class: 'bc-navhead', text: n.Title }));
        else if (l) menu.append(el('a', { href: l.href, class: depth ? 'bc-navsub' : null, target: l.external ? '_blank' : null, rel: l.external ? 'noopener' : null, text: n.Title, role: 'menuitem' }));
        for (const c of n.Nodes || []) if (!c.IsHidden) add(c, depth + 1);
      };
      for (const c of node.Nodes) if (!c.IsHidden) add(c, 0);
      menu.style.top = `${r.bottom + 2}px`;
      menu.style.left = `${r.left}px`;
      menu.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      menu.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 250); });
      document.body.append(menu);
    };
    a.addEventListener('mouseenter', open);
    a.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 250); });
    a.addEventListener('click', (e) => { if (a.tagName !== 'A' || !a.getAttribute('href')) { e.preventDefault(); menu ? hide() : open(); } });
  }
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) hide(); });
}

// ---------------------------------------------------------------- collapsible sections
// Snapshots were taken with every collapsible section expanded (their web
// parts don't render otherwise). Restore the authored collapsed state and
// make the headers toggle again.

function sectionContent(button) {
  return button.closest('[data-automation-id="CanvasZone"]')?.querySelector('[data-automation-id="CollapsibleLayer-Content"]');
}

function setSection(button, open) {
  const content = sectionContent(button);
  if (!content) return;
  content.style.display = open ? '' : 'none';
  button.setAttribute('aria-expanded', String(open));
  const icon = button.querySelector('[data-automation-id^="CollapsibleLayer-Icon"]');
  if (icon) icon.style.transform = open ? '' : 'rotate(180deg)';   // captured expanded (chevron up); collapsed shows it down
}

function mountCollapsibles() {
  for (const b of document.querySelectorAll('[data-automation-id="CollapsibleLayer-Button"]')) {
    if (b.hasAttribute('data-bc-was-collapsed')) setSection(b, false);
    b.style.cursor = 'pointer';
    b.addEventListener('click', () => setSection(b, b.getAttribute('aria-expanded') !== 'true'));
  }
}

/** Open any collapsed section that contains `el`. */
function revealInSection(el) {
  const faq = el.closest('details');
  if (faq) faq.open = true;
  const content = el.closest('[data-automation-id="CollapsibleLayer-Content"]');
  const button = content?.closest('[data-automation-id="CanvasZone"]')?.querySelector('[data-automation-id="CollapsibleLayer-Button"]');
  if (button && button.getAttribute('aria-expanded') !== 'true') setSection(button, true);
}

// ---------------------------------------------------------------- deep-link highlight

function highlightFromHash() {
  const m = /#bc-hl=(.+)$/.exec(location.hash);
  if (!m) return;
  let hl;
  try { hl = JSON.parse(decodeURIComponent(m[1])); } catch { return; }

  const root = document.querySelector('[data-automation-id="contentScrollRegion"]') || document.body;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Concatenate text nodes so a phrase spanning several nodes can be found.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('.bc-pane, script, style')) continue;
    const t = n.textContent.replace(/\s+/g, ' ');
    if (!t.trim()) continue;
    nodes.push({ n, start: text.length });
    text += t;
  }
  const hay = text.toLowerCase();

  // A list row shows on the page under its own title (an FAQ question, a
  // tip-sheet name); a page chunk is best found by its opening words. Short
  // snippets ("Yes.") would match anywhere, so they're skipped.
  const snippet = norm(hl.t).replace(/^- /, '');
  const fromText = snippet.length >= 25 ? [snippet.slice(0, 80), snippet.slice(0, 40), snippet.split(' ').slice(0, 6).join(' ')] : [];
  const candidates = hl.list
    ? [norm(hl.title), ...fromText]
    : [...fromText, norm(hl.h), norm(hl.title)];

  let at = -1;
  for (const c of candidates) { if (c && c.length > 3 && (at = hay.indexOf(c)) >= 0) break; }
  if (at < 0) { toast('Opened the cited page.'); return; }

  const hit = nodes.findLast((x) => x.start <= at);
  if (hit) revealInSection(hit.n.parentElement);
  let target = hit?.n.parentElement;
  // Highlight a sensible block, not a single inline span.
  while (target && getComputedStyle(target).display === 'inline' && target.parentElement) target = target.parentElement;
  if (!target) return;
  target.scrollIntoView({ behavior: document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  target.classList.add('bc-hl');
  setTimeout(() => target.classList.add('bc-hl-fade'), 2600);
  setTimeout(() => target.classList.remove('bc-hl', 'bc-hl-fade'), 3400);
}

function toast(msg) {
  const t = el('div', { class: 'bc-toast', role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------------------------------------------------------------- images
// A few images (news thumbnails, document previews) live on Microsoft CDNs
// that don't allow cross-origin capture, so the replica can only show them
// while this browser is signed in to SharePoint. Otherwise show a quiet
// placeholder instead of a broken-image icon.

const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#EDEBE9"/></svg>')}`;

function mountImageFallbacks() {
  const swap = (img) => { if (img.src !== PLACEHOLDER) { img.src = PLACEHOLDER; img.style.objectFit = 'cover'; } };
  for (const img of document.images) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) swap(img);
    else img.addEventListener('error', () => swap(img), { once: true });
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  mountPane();
  mountSuiteButton();
  hookSearch();
  mountNavMenus();
  mountCollapsibles();
  mountImageFallbacks();
  renderThread();
  if (state.open) setOpen(true);
  // Let the page settle (fonts, images) before measuring for the highlight.
  setTimeout(highlightFromHash, 400);
  addEventListener('hashchange', highlightFromHash);

  const h = await health(API);
  footMode.textContent = !h ? 'Assistant server offline'
    : h.mode === 'claude' ? `Answers from ${h.sources.toLocaleString()} BetterCare sources`
      : 'Retrieval-only mode (no API key)';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
