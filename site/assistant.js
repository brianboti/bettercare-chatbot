// Sophia Assistant, integrated into the site replica.
//
// What an SPFx integration on the real site would provide:
//   - a Copilot-style pane on every page (suite-bar button + floating launcher)
//   - a personal welcome: Sophia introduces itself on first visit, asks the
//     person's role, then greets them with suggestions built for them (what
//     Clinical IT wants them to see, what they asked before, what people in
//     the same role ask, what's new)
//   - question history, feedback, quick replies and follow-up questions
//   - the "Search this site" box upgraded: live semantic results as you type,
//     Enter asks the assistant; a toggle shows what classic keyword search finds
//   - citations that open the cited page and highlight the exact passage
//   - working dropdowns for the site navigation
//
// Who is signed in: on the real site SharePoint provides the user. The
// replica has no sign-in, so a "signed in as" switcher in the suite bar picks
// a demo person (or "someone new" to see the first-run introduction).
//
// The open conversation lives in sessionStorage, so the pane stays open with
// its history when a citation navigates to another page. Everything else
// (profile, history) is on the server.

import { streamChat, searchApi, health, apiJson } from '/lib/chat-api.js';
import { renderAnswer } from '/lib/render.js';

const API = location.origin;
const USER_KEY = 'sophia-user';

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
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 2.7 1.2 2.3 2.8L12.6 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 13V4H4v9zM7 13l4 8c1.7 0 2.7-1.2 2.3-2.8L12.6 15H19a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 17.8 4H7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
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
const firstName = (name) => (name || '').replace(/^(Dr\.?|Mr\.?|Ms\.?|Mrs\.?)\s+/i, '').split(/\s+/)[0] || '';
const initials = (name) => (name || '?').replace(/^(Dr\.?)\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// ---------------------------------------------------------------- who is signed in

function loadUserId() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw).id || null; } catch { return raw; }
  } catch { return null; }
}

function setUserId(id) {
  try { localStorage.setItem(USER_KEY, JSON.stringify({ id })); } catch { /* private mode */ }
}

// A first visit with no one picked is "someone new": the introduction runs.
let userId = loadUserId();
if (!userId) { userId = `guest-${Math.random().toString(36).slice(2, 10)}`; setUserId(userId); }
let me = null;          // server profile, or null until loaded
let roles = [];

const api = (path, opts = {}) => apiJson(API, path, { userId, ...opts });

/** Usage events for the insights dashboard. Survives page navigation. */
function track(type, fields = {}) {
  try {
    fetch(`${API}/api/events`, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Sophia-User': userId },
      body: JSON.stringify({ type, ...fields }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- conversation state

const STORE = () => `bc-assistant-v2:${userId}`;
const newConversationId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function load() {
  try { return JSON.parse(sessionStorage.getItem(STORE())) || null; } catch { return null; }
}
function save() {
  try {
    sessionStorage.setItem(STORE(), JSON.stringify({ open: state.open, conversationId: state.conversationId, turns: state.turns.filter((t) => !t.pending) }));
  } catch { /* private mode */ }
}

const state = { open: false, conversationId: newConversationId(), turns: [], ...load() };
let view = 'chat';        // 'chat' | 'history'
let welcomeData = null;   // cached /api/welcome result
let busy = false;
let ctl = null;

// ---------------------------------------------------------------- navigation to a source

/** Where a citation goes: the local page (highlighting the passage) or the file. */
function sourceHref(s) {
  if (!s.localUrl) return { href: s.url, external: true };
  if (s.sourceType === 'document') return { href: s.localUrl, external: true };
  const hl = { h: s.headingPath?.[s.headingPath.length - 1] || null, t: s.snippet?.slice(0, 90), title: s.title, list: s.sourceType === 'list-item' };
  return { href: `${s.localUrl.split('#')[0]}#bc-hl=${encodeURIComponent(JSON.stringify(hl))}`, external: false };
}

function openSource(s, e, t) {
  if (t) track('citation_click', { turnId: t.turnId, ref: s.id, data: { title: s.title, kind: s.kind, url: s.url } });
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

let pane, thread, input, sendBtn, footMode, historyBtn;

function mountPane() {
  thread = el('div', { class: 'bc-thread', 'aria-live': 'polite' });
  input = el('textarea', { rows: '1', placeholder: 'Ask about Epic, Abridge, training, upgrades…', 'aria-label': 'Ask Sophia', id: 'bc-input' });
  sendBtn = el('button', { class: 'bc-send', type: 'submit', 'aria-label': 'Send', svg: ICON.send, disabled: '' });
  footMode = el('span', { text: 'Answers from BetterCare content only' });

  const form = el('form', { class: 'bc-composer' }, [
    el('div', { class: 'bc-field' }, [input, sendBtn]),
    el('div', { class: 'bc-foot' }, [footMode, el('span', { text: 'Shift+Enter for a new line' })]),
  ]);

  historyBtn = el('button', { class: 'bc-icon-btn', type: 'button', title: 'Your past questions', 'aria-label': 'History', svg: ICON.history, onclick: () => (view === 'history' ? showChat() : showHistory()) });
  pane = el('aside', { class: 'bc-pane', role: 'complementary', 'aria-label': 'Sophia Assistant' }, [
    el('div', { class: 'bc-head' }, [
      el('div', { class: 'bc-mark', svg: ICON.spark }),
      el('div', { class: 'bc-title' }, [el('b', { text: 'Sophia Assistant' }), el('span', { text: 'Searches every page, list and document on BetterCare' })]),
      historyBtn,
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
  state.conversationId = newConversationId();
  save();
  showChat();
  input.focus();
}

function showChat() {
  view = 'chat';
  historyBtn.classList.remove('bc-on');
  renderThread();
}

function renderThread() {
  thread.replaceChildren();
  if (!state.turns.length) { renderWelcome(); return; }
  const last = state.turns[state.turns.length - 1];
  for (const t of state.turns) thread.append(t.role === 'user' ? userTurn(t.content) : assistantTurn(t, t === last).node);
  thread.scrollTop = thread.scrollHeight;
}

// ---------------------------------------------------------------- welcome and first-run introduction

function sophiaSays(...children) {
  return el('div', { class: 'bc-intro-msg' }, [el('div', { class: 'bc-mark bc-mark--sm', svg: ICON.spark, 'aria-hidden': 'true' }), el('div', {}, children)]);
}

/** Muse-style first run: introduce, ask the name, then the role. One question at a time. */
function renderIntroduction() {
  const box = el('div', { class: 'bc-welcome bc-intro' });
  thread.append(box);
  box.append(sophiaSays(
    el('h2', { text: "Hi, I'm Sophia." }),
    el('p', { text: "I find things on BetterCare for you: tip sheets, what changed in an upgrade, training dates, who to call. I also remember what you've asked, so I get more useful over time." }),
  ));

  const askRole = (name) => {
    const chips = el('div', { class: 'bc-chips', role: 'group', 'aria-label': 'Your role' }, roles.map((r) => el('button', {
      class: 'bc-chip', type: 'button', text: r.label,
      onclick: async () => {
        for (const b of chips.querySelectorAll('button')) b.disabled = true;
        const res = await api('/api/me', { body: { role: r.key, ...(name ? { name } : {}) } });
        if (res?.user) me = res.user;
        welcomeData = null;
        if (!state.turns.length) renderThread();
        renderUserButton();
      },
    })));
    box.append(sophiaSays(
      el('p', { class: 'bc-intro-q', text: `${name ? `Nice to meet you, ${firstName(name)}. ` : ''}What's your role? I'll show you what matters for your work.` }),
      chips,
    ));
    chips.querySelector('button')?.focus();
  };

  if (me?.name) { askRole(null); return; }
  const nameInput = el('input', { class: 'bc-intro-input', type: 'text', id: 'bc-intro-name', placeholder: 'Your first name', autocomplete: 'given-name', 'aria-label': 'Your name', maxlength: '60' });
  const form = el('form', { class: 'bc-intro-form' }, [
    nameInput,
    el('button', { class: 'bc-chip bc-chip--primary', type: 'submit', text: 'Continue' }),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    form.replaceWith(el('div', { class: 'bc-intro-answer', text: name || '(skipped)' }));
    askRole(name || null);
  });
  box.append(sophiaSays(el('p', { class: 'bc-intro-q', text: 'What should I call you?' }), form));
  setTimeout(() => nameInput.focus(), 60);
}

async function renderWelcome() {
  if (!me?.role) { renderIntroduction(); return; }

  const box = el('div', { class: 'bc-welcome' });
  thread.append(box);
  const greeting = el('h2', { text: me?.name ? `Hi ${firstName(me.name)}.` : 'Hi.' });
  const cards = el('div', { class: 'bc-cards', 'aria-busy': 'true' }, [0, 1, 2].map(() => el('div', { class: 'bc-card bc-card--skeleton', 'aria-hidden': 'true' })));
  const recent = el('div', { class: 'bc-recent' });
  box.append(greeting, el('p', { text: 'Ask me anything about BetterCare, or start here:' }), cards, recent);

  const [w, h] = await Promise.all([welcomeData || api('/api/welcome'), api('/api/history')]);
  if (!box.isConnected) return;
  welcomeData = w;
  if (w?.needsOnboarding) { me = w.user || me; box.remove(); renderIntroduction(); return; }
  if (w?.greeting) greeting.textContent = w.greeting;
  cards.removeAttribute('aria-busy');
  cards.replaceChildren(...(w?.cards || []).map(welcomeCard));
  if (!w?.cards?.length) cards.remove();

  const convs = (h?.conversations || []).slice(0, 3);
  if (convs.length) {
    recent.append(
      el('div', { class: 'bc-recent-head' }, [el('span', { text: 'Pick up where you left off' }), el('button', { type: 'button', class: 'bc-link-btn', text: 'All history', onclick: showHistory })]),
      ...convs.map((c) => el('button', { type: 'button', class: 'bc-recent-item', onclick: () => openConversation(c.conversationId) }, [
        el('span', { text: c.title }), el('small', { text: dayLabel(c.lastAt) }),
      ])),
    );
  }
}

function welcomeCard(c) {
  const card = el('div', { class: `bc-card bc-card--${c.source}` });
  const go = el('button', {
    type: 'button', class: 'bc-card-main',
    onclick: () => {
      track(c.promoId ? 'promo_click' : 'welcome_card_click', { ref: c.promoId ?? c.id, data: { source: c.source } });
      ask(c.prompt, c.url ? { link: { title: c.label, url: c.url, promoId: c.promoId } } : {});
    },
  }, [el('span', { class: 'bc-card-lead', text: c.lead }), el('span', { class: 'bc-card-label', text: c.label })]);
  card.append(go);
  if (c.url) card.append(featuredLink({ title: c.label, url: c.url, promoId: c.promoId }, 'bc-card-open', 'Open ↗'));
  if (c.promoId) {
    card.append(el('button', {
      type: 'button', class: 'bc-card-x', title: 'Not interested', 'aria-label': `Dismiss: ${c.label}`, svg: ICON.close,
      onclick: () => { track('promo_dismiss', { ref: c.promoId }); card.remove(); welcomeData = null; },
    }));
  }
  return card;
}

/** A link Clinical IT attached to pushed content: on its welcome card, and above the answer it leads to. */
function featuredLink(link, cls, text) {
  const l = localize(link.url) || { href: link.url, external: true };
  return el('a', {
    class: cls, href: l.href, target: l.external ? '_blank' : null, rel: l.external ? 'noopener' : null,
    title: link.url, text,
    onclick: () => track('promo_link_click', { ref: link.promoId, data: { url: link.url } }),
  });
}

// ---------------------------------------------------------------- history

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((today - that) / 86_400_000);
  if (days === 0) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function showHistory() {
  view = 'history';
  historyBtn.classList.add('bc-on');
  track('history_open');
  thread.replaceChildren(el('div', { class: 'bc-history' }, [
    el('div', { class: 'bc-history-head' }, [
      el('button', { type: 'button', class: 'bc-icon-btn', 'aria-label': 'Back to the conversation', svg: ICON.back, onclick: showChat }),
      el('h3', { text: 'Your questions' }),
    ]),
    el('p', { class: 'bc-muted', text: 'Loading…' }),
  ]));
  const h = await api('/api/history');
  if (view !== 'history') return;
  const list = thread.querySelector('.bc-history');
  list.lastChild.remove();
  const convs = h?.conversations || [];
  if (!convs.length) { list.append(el('p', { class: 'bc-muted', text: "Nothing yet. Questions you ask show up here, so you can come back to an answer." })); return; }

  // Group by day.
  let group = null, label = null;
  for (const c of convs) {
    const l = dayLabel(c.lastAt).replace(/^Today.*/, 'Today');
    if (l !== label) { label = l; group = el('ul', { class: 'bc-history-list' }); list.append(el('h4', { text: l }), group); }
    group.append(el('li', {}, [el('button', {
      type: 'button', class: 'bc-history-item', onclick: () => openConversation(c.conversationId),
    }, [
      el('span', { text: c.title }),
      el('small', { text: `${c.turns} question${c.turns > 1 ? 's' : ''}` }),
    ])]));
  }
}

async function openConversation(conversationId) {
  const r = await api(`/api/history/${encodeURIComponent(conversationId)}`);
  if (!r?.turns?.length) return;
  ctl?.abort();
  state.conversationId = conversationId;
  state.turns = r.turns.flatMap((t) => [
    { role: 'user', content: t.question },
    { role: 'assistant', content: t.answer || '', sources: t.sources || [], turnId: t.id, feedback: t.feedback, feedbackNote: t.feedbackNote, suggestions: t.suggestions, error: t.error ? { message: 'This answer didn\'t finish.' } : null },
  ]);
  save();
  showChat();
}

// ---------------------------------------------------------------- turns

function userTurn(text) {
  return el('div', { class: 'bc-turn bc-turn--user' }, [el('div', { class: 'bc-bubble', text })]);
}

/** Build (or rebuild) an assistant turn's DOM from its state. `latest` shows quick replies. */
function assistantTurn(t, latest = true) {
  const node = el('div', { class: 'bc-turn' });
  const answer = el('div', { class: 'bc-answer' });
  const status = el('div', { class: 'bc-status' }, [el('span', { class: 'bc-dots' }, [el('i'), el('i'), el('i')]), el('span', { text: '' })]);
  const extras = el('div', { class: 'bc-extras' });
  const sources = el('div', { class: 'bc-sources' });
  node.append(status, answer, extras, sources);

  const cite = (n) => {
    const s = t.sources?.[n - 1];
    if (!s) return null;
    const { href, external } = sourceHref(s);
    return el('a', {
      class: 'bc-cite', href, title: s.title, text: String(n),
      target: external ? '_blank' : null, rel: external ? 'noopener' : null,
      onclick: (e) => openSource(s, e, t),
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

    extras.replaceChildren();
    if (!t.pending && !t.error && t.content) {
      // Quick replies (Sophia asked something) or related questions, on the latest answer only.
      const sug = latest && state.turns[state.turns.length - 1] === t ? t.suggestions : null;
      if (sug?.items?.length) {
        extras.append(el('div', { class: `bc-sugs bc-sugs--${sug.kind}` }, [
          sug.kind === 'followup' ? el('span', { class: 'bc-sugs-label', text: 'Related' }) : null,
          ...sug.items.map((q) => el('button', {
            type: 'button', class: 'bc-chip', text: q,
            onclick: () => { track('suggestion_click', { turnId: t.turnId, data: { kind: sug.kind, text: q } }); ask(q); },
          })),
        ]));
      }
      extras.append(answerActions(t, latest));
    }

    sources.replaceChildren();
    if (t.error) {
      sources.append(el('div', { class: 'bc-notice bc-notice--error' }, [
        t.error.message,
        t.retry ? el('button', { type: 'button', text: 'Retry', onclick: () => retry(t) }) : null,
      ]));
    }
    if (!t.pending && t.link) {
      const a = featuredLink(t.link, 'bc-featured', '');
      a.append(el('span', { class: 'bc-featured-lead', text: 'Featured by Clinical IT' }), el('b', { text: t.link.title }), el('small', { text: `${t.link.url.replace(/^https:\/\//, '').slice(0, 70)} ↗` }));
      sources.append(a);
    }
    if (!t.pending && t.sources?.length) {
      const cited = new Set([...(t.content || '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim()))));
      // Sources arrive newest first; much older ones go under "Older results".
      const current = t.sources.filter((s) => !s.older);
      const older = t.sources.filter((s) => s.older);
      const shown = current.filter((s) => cited.has(s.n));
      const top = shown.length ? shown : current.slice(0, 4);
      if (top.length) sources.append(el('div', { class: 'bc-sources' }, top.map((s) => sourceCard(s, t))));
      const toggle = (label, list) => {
        const extra = el('div', { class: 'bc-sources', hidden: '' }, list.map((s) => sourceCard(s, t)));
        const btn = el('button', {
          class: 'bc-sources-toggle', type: 'button', 'aria-expanded': 'false', text: `${label} (${list.length})`,
          onclick: () => { extra.hidden = !extra.hidden; btn.setAttribute('aria-expanded', String(!extra.hidden)); btn.textContent = extra.hidden ? `${label} (${list.length})` : `Hide ${label.toLowerCase()}`; },
        });
        sources.append(btn, extra);
      };
      const more = current.filter((s) => !top.includes(s));
      if (more.length) toggle('More results', more);
      if (older.length) toggle('Older results', older);
    }
  };
  paint();
  return { node, paint };
}

/** Thumbs up/down (with an optional comment), shorter / more detail, copy. */
function answerActions(t, latest) {
  const row = el('div', { class: 'bc-actions' });
  const thanks = el('span', { class: 'bc-thanks', role: 'status' });
  const form = feedbackForm(t, (msg) => { thanks.textContent = msg; });
  const vote = (value) => async () => {
    if (!t.turnId) return;
    t.feedback = t.feedback === value ? null : value;
    t.feedbackNote = null;
    save();
    up.classList.toggle('bc-on', t.feedback === 1);
    down.classList.toggle('bc-on', t.feedback === -1);
    thanks.textContent = '';
    form.toggle(t.feedback);
    await api('/api/feedback', { body: { turnId: t.turnId, value: t.feedback || 0 } });
  };
  const up = el('button', { type: 'button', class: `bc-act${t.feedback === 1 ? ' bc-on' : ''}`, title: 'Helpful', 'aria-label': 'Helpful', svg: ICON.up, onclick: vote(1), disabled: t.turnId ? null : '' });
  const down = el('button', { type: 'button', class: `bc-act${t.feedback === -1 ? ' bc-on' : ''}`, title: 'Not helpful', 'aria-label': 'Not helpful', svg: ICON.down, onclick: vote(-1), disabled: t.turnId ? null : '' });
  const copy = el('button', {
    type: 'button', class: 'bc-act', title: 'Copy answer', 'aria-label': 'Copy answer', svg: ICON.copy,
    onclick: () => {
      navigator.clipboard?.writeText(t.content.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')).then(() => { thanks.textContent = 'Copied.'; }, () => {});
      track('copy_answer', { turnId: t.turnId });
    },
  });
  row.append(up, down, copy);
  if (latest && state.turns[state.turns.length - 1] === t) {
    row.append(
      el('button', { type: 'button', class: 'bc-act bc-act--text', text: 'Shorter', onclick: () => ask('Give me the short version.') }),
      el('button', { type: 'button', class: 'bc-act bc-act--text', text: 'More detail', onclick: () => ask('Tell me more, with the details.') }),
    );
  }
  row.append(thanks);
  return el('div', {}, [row, form.node]);
}

/** "Tell us more" box that opens under the thumbs. Saves the comment with the rating. */
function feedbackForm(t, done) {
  const box = el('textarea', { class: 'bc-fb-text', rows: '3', maxlength: '500', 'aria-label': 'Your feedback' });
  const label = el('label', { class: 'bc-fb-label' });
  const err = el('span', { class: 'bc-fb-err', role: 'alert' });
  const send = el('button', { type: 'submit', class: 'bc-fb-send', text: 'Send' });
  const close = () => { node.hidden = true; };
  const node = el('form', {
    class: 'bc-fb', hidden: '',
    onsubmit: async (e) => {
      e.preventDefault();
      const note = box.value.trim();
      if (!note) { close(); done(t.feedback > 0 ? 'Thanks!' : "Thanks. This helps us fix what's missing."); return; }
      send.disabled = true;
      err.textContent = '';
      const ok = await api('/api/feedback', { body: { turnId: t.turnId, value: t.feedback, note } });
      send.disabled = false;
      if (!ok) { err.textContent = "Couldn't send. Try again."; return; }
      t.feedbackNote = note;
      save();
      close();
      done('Thanks, your feedback was sent.');
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) node.requestSubmit();
    },
  }, [
    label, box,
    el('div', { class: 'bc-fb-foot' }, [
      err,
      el('small', { text: 'Read by the Clinical IT team.' }),
      el('button', { type: 'button', class: 'bc-fb-skip', text: 'Skip', onclick: () => { close(); done(t.feedback > 0 ? 'Thanks!' : "Thanks. This helps us fix what's missing."); } }),
      send,
    ]),
  ]);
  const id = `bc-fb-${t.turnId}`;
  box.id = id;
  label.setAttribute('for', id);
  return {
    node,
    toggle(value) {
      if (!value) { close(); return; }
      label.textContent = value > 0 ? 'What was helpful? (optional)' : 'What was wrong or missing? (optional)';
      box.placeholder = value > 0 ? 'e.g. It linked straight to the tip sheet I needed' : 'e.g. It pointed to the old version of the policy';
      box.value = '';
      err.textContent = '';
      node.hidden = false;
      box.focus();
    },
  };
}

const fmtSourceDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d)
  ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : d);

function sourceCard(s, t) {
  const { href, external } = sourceHref(s);
  const when = s.date ? fmtSourceDate(s.date) : s.updated ? `Updated ${fmtSourceDate(s.updated)}` : null;
  const where = [kindLabel(s.kind), s.headingPath?.filter(Boolean).join(' › ') || s.list, when].filter(Boolean).join(' · ');
  const card = el('a', {
    class: 'bc-src', href, target: external ? '_blank' : null, rel: external ? 'noopener' : null,
    onclick: (e) => openSource(s, e, t),
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

async function ask(question, { link = null } = {}) {
  if (busy) return;
  if (!state.open) setOpen(true);
  if (view !== 'chat') { view = 'chat'; historyBtn.classList.remove('bc-on'); }
  if (!state.turns.length) thread.replaceChildren();
  else renderThread();   // drops the previous answer's quick replies

  state.turns.push({ role: 'user', content: question });
  thread.append(userTurn(question));
  const t = { role: 'assistant', content: '', pending: true, status: 'Thinking…', sources: [], link };
  state.turns.push(t);
  const v = assistantTurn(t);
  thread.append(v.node);
  thread.scrollTop = thread.scrollHeight;
  welcomeData = null;     // the welcome is rebuilt from the new history next time
  await stream(t, v);
}

async function stream(t, v) {
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
      frame = 0; v.paint();
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    });
  };

  await streamChat(API, history, {
    status: (d) => { t.status = STAGES[d.stage] || t.status; repaint(); },
    sources: (s) => { t.sources = s; repaint(); },
    token: (d) => { t.content += d.text; repaint(); },
    suggestions: (s) => { t.suggestions = s; },
    reset: () => { t.content = ''; repaint(); },
    error: (e) => {
      t.error = e.code === 'UNREACHABLE' ? { message: "Can't reach the assistant server. Is `npm start` running?" }
        : e.code === 'RATE_LIMITED' ? { message: e.message || 'Too many questions — wait a moment.' }
        : { message: e.message || 'Something went wrong.' };
      t.retry = e.code !== 'REFUSED';
    },
    done: (d) => { t.turnId = d.turnId; t.meta = { mode: d.mode, model: d.model, latencyMs: d.latencyMs }; },
  }, ctl.signal, { userId, conversationId: state.conversationId });

  if (ctl.signal.aborted && !t.content) t.error = { message: 'Stopped.' };
  t.pending = false;
  busy = false;
  ctl = null;
  sendBtn.innerHTML = ICON.send;
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.disabled = !input.value.trim();
  v.paint();
  thread.scrollTop = thread.scrollHeight;
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

// ---------------------------------------------------------------- suite bar: Ask Sophia + who is signed in

let userBtn = null;

function mountSuiteButton() {
  const region = document.querySelector('#O365_HeaderRightRegion');
  if (!region) return;
  userBtn = el('button', { class: 'bc-user-btn', type: 'button', 'aria-haspopup': 'menu', onclick: toggleUserMenu });
  region.prepend(
    el('button', { class: 'bc-suite-btn', type: 'button', svg: `${ICON.spark}<span>Ask Sophia</span>`, onclick: () => setOpen(!state.open) }),
    userBtn,
  );
  renderUserButton();
}

function renderUserButton() {
  if (!userBtn) return;
  userBtn.replaceChildren(el('span', { class: 'bc-avatar', text: me?.name ? initials(me.name) : '?' }));
  userBtn.title = me?.name ? `Signed in as ${me.name} (demo). Click to switch.` : 'New visitor (demo). Click to switch.';
  userBtn.setAttribute('aria-label', userBtn.title);
}

let userMenu = null;
async function toggleUserMenu(e) {
  e.stopPropagation();
  if (userMenu) { userMenu.remove(); userMenu = null; return; }
  const r = await api('/api/demo-users');
  const roleLabel = (k) => roles.find((x) => x.key === k)?.label || '';
  const switchTo = (id) => {
    setUserId(id);
    // Each person has their own open conversation.
    location.reload();
  };
  userMenu = el('div', { class: 'bc-usermenu', role: 'menu' }, [
    el('div', { class: 'bc-usermenu-head' }, [
      el('b', { text: me?.name || 'New visitor' }),
      el('small', { text: [roleLabel(me?.role), me?.department].filter(Boolean).join(' · ') || 'First visit' }),
    ]),
    el('div', { class: 'bc-usermenu-label', text: 'Demo: sign in as' }),
    ...(r?.users || []).map((u) => el('button', {
      type: 'button', role: 'menuitem', class: u.id === userId ? 'bc-on' : null, onclick: () => switchTo(u.id),
    }, [el('span', { class: 'bc-avatar bc-avatar--sm', text: initials(u.name) }), el('span', {}, [u.name, el('small', { text: roleLabel(u.role) })])])),
    el('button', { type: 'button', role: 'menuitem', onclick: () => switchTo(`guest-${Math.random().toString(36).slice(2, 10)}`) }, [
      el('span', { class: 'bc-avatar bc-avatar--sm', text: '+' }), el('span', {}, ['Someone new', el('small', { text: 'See the first-visit introduction' })]),
    ]),
    me?.isAdmin ? el('a', { class: 'bc-usermenu-link', href: '/admin', target: '_blank', rel: 'noopener', role: 'menuitem', text: 'Open the insights dashboard ↗' }) : null,
  ]);
  const rect = userBtn.getBoundingClientRect();
  userMenu.style.top = `${rect.bottom + 6}px`;
  userMenu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
  document.body.append(userMenu);
}
document.addEventListener('mousedown', (e) => { if (userMenu && !userMenu.contains(e.target) && !userBtn?.contains(e.target)) { userMenu.remove(); userMenu = null; } });

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

// ---------------------------------------------------------------- full-width section above a vertical section
// On a page with a vertical section (the home page's help-desk column),
// SharePoint pins the full-width top section with position:absolute and its
// own script pushes the columns down by its height. That script doesn't run
// in a snapshot, so the columns slid up under the banner. Push them down here.

function mountFullWidthTop() {
  const fit = () => {
    for (const s of document.querySelectorAll('.canvasSectionTopFullWidth.withVerticalSection')) {
      const canvas = s.closest('[data-automation-id="Canvas"]');
      if (canvas) canvas.style.paddingTop = `${s.offsetHeight}px`;
    }
  };
  fit();
  addEventListener('load', fit);
  addEventListener('resize', fit);
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
  // Who is signed in, before anything personal renders.
  const r = await api('/api/me');
  roles = r?.roles || [];
  me = r?.user || null;

  mountPane();
  mountSuiteButton();
  hookSearch();
  mountNavMenus();
  mountCollapsibles();
  mountImageFallbacks();
  mountFullWidthTop();
  renderThread();
  if (state.open) setOpen(true);
  // Let the page settle (fonts, images) before measuring for the highlight.
  setTimeout(highlightFromHash, 400);
  addEventListener('hashchange', highlightFromHash);

  // Build the personal welcome in the background, so it's ready when the pane opens.
  if (me?.role && !state.turns.length && !state.open) api('/api/welcome').then((w) => { if (w && !welcomeData) welcomeData = w; });

  const h = await health(API);
  footMode.textContent = !h ? 'Assistant server offline'
    : h.mode === 'claude' ? `Answers from ${h.sources.toLocaleString()} BetterCare sources`
      : 'Retrieval-only mode (no API key)';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
