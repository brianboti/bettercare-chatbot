// Sophia Assistant — side panel.
//
// Online: a chat client of the Sophia RAG server (server/, `npm start`).
// Each question streams back a Claude answer grounded in the whole site —
// pages, documents and lists — with [n] citations to the SharePoint source.
//
// Offline (server unreachable): falls back to keyword search over the corpus
// bundled at build time (data/corpus.json) and shows matches verbatim.

import { DEFAULT_API, health, streamChat } from './lib/chat-api.js';
import { renderAnswer } from './lib/render.js';
import { buildIndex, search } from './search.js';

const SUGGESTIONS = [
  { kind: 'page',     q: 'How do I set up Haiku on my phone?' },
  { kind: 'event',    q: 'When is the next Epic upgrade?' },
  { kind: 'faq',      q: 'How do I get Abridge access?' },
  { kind: 'catalog',  q: "Where's the cash drawer tip sheet?" },
  { kind: 'resource', q: 'Who do I contact for Epic help?' },
];

const STATUS_TEXT = {
  rewriting: 'Understanding your question…',
  retrieving: 'Searching the site…',
  generating: 'Writing answer…',
};

const ERROR_TEXT = {
  UNREACHABLE: "Can't reach the assistant server.",
  RATE_LIMITED: 'Too many questions in a short time.',
  UPSTREAM_LLM: 'The AI service had a problem.',
  REFUSED: "I can't help with that one.",
  INTERNAL: 'Something went wrong on the server.',
};

const KIND_LABEL = {
  page: 'Page', news: 'News', faq: 'FAQ', glossary: 'Glossary', catalog: 'Tip sheet',
  feature: 'Epic feature', event: 'Event', resource: 'Resource', announcement: 'Announcement',
  directory: 'Directory', document: 'Document', slides: 'Slides', spreadsheet: 'Spreadsheet', file: 'File',
};

// ---------------------------------------------------------------- utilities

const $ = (sel) => document.querySelector(sel);

/** Build an element. Children may be nodes or strings (set as text). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

const thread = () => $('#thread');
const scrollDown = () => { thread().scrollTop = thread().scrollHeight; };

// ---------------------------------------------------------------- connection

let API = DEFAULT_API;
let mode = 'checking';       // 'claude' | 'retrieval-only' | 'offline' | 'checking'
let OFFLINE_INDEX = null;

async function loadSettings() {
  try {
    const { apiUrl } = await chrome.storage.local.get('apiUrl');
    if (apiUrl) API = apiUrl.replace(/\/+$/, '');
  } catch { /* storage unavailable: keep the default */ }
}

function setScope(state, label, count = '') {
  const scope = $('#scope');
  scope.dataset.state = state;
  $('#scope-label').replaceChildren(el('b', { text: label }));
  $('#count').textContent = count;
  const tag = $('#mode-tag');
  tag.textContent = { claude: 'AI', 'retrieval-only': 'Search only', offline: 'Offline', checking: '' }[state] ?? '';
  tag.title = {
    claude: 'Answers written by Claude from site content',
    'retrieval-only': 'Server has no API key: shows matching site content',
    offline: 'Server unreachable: keyword search over bundled content',
  }[state] ?? '';
  tag.hidden = !tag.textContent;
}

async function connect() {
  setScope('checking', 'Connecting…');
  const h = await health(API);
  if (h?.ok) {
    mode = h.mode === 'claude' ? 'claude' : 'retrieval-only';
    setScope(mode, mode === 'claude' ? 'Connected' : 'Retrieval-only mode',
      `${Number(h.chunks).toLocaleString()} items`);
    return true;
  }
  mode = 'offline';
  setScope('offline', 'Offline — using bundled search', '');
  await loadOfflineCorpus();
  return false;
}

async function loadOfflineCorpus() {
  if (OFFLINE_INDEX) return;
  try {
    const res = await fetch(chrome.runtime.getURL('data/corpus.json'));
    const corpus = await res.json();
    OFFLINE_INDEX = buildIndex(corpus);
    $('#count').textContent = `${corpus.length} items`;
  } catch (err) {
    console.error('[Sophia] offline corpus', err);
  }
}

// ---------------------------------------------------------------- welcome

function showWelcome() {
  history.length = 0;
  thread().replaceChildren(
    el('div', { class: 'welcome' }, [
      el('h1', { text: "Hi, I'm Sophia. Ask anything on the BetterCare site." }),
      el('p', {
        text: 'Pages, tip sheets, upgrade guides, FAQs, events and training. '
            + 'Every answer links back to where it came from.',
      }),
      el('div', { class: 'suggests' }, SUGGESTIONS.map((s) => {
        const b = el('button', { class: 'suggest', type: 'button', 'data-kind': s.kind }, [
          el('i', { 'aria-hidden': 'true' }),
          s.q,
        ]);
        b.addEventListener('click', () => ask(s.q));
        return b;
      })),
    ]),
  );
}

// ---------------------------------------------------------------- rendering

function addUserTurn(text) {
  thread().append(el('div', { class: 'turn turn--user' }, [el('div', { class: 'bubble', text })]));
  scrollDown();
}

function thinking(text) {
  return el('div', { class: 'thinking' }, [
    el('span', { class: 'thinking__dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
    el('span', { class: 'thinking__text', text }),
  ]);
}

/** Inline [n] chip linking to source n. */
function citeChip(sources, n) {
  const s = sources.find((x) => x.n === n);
  if (!s) return null;
  return el('a', {
    class: 'cite-chip', href: s.url, target: '_blank', rel: 'noopener',
    title: s.title, 'data-kind': s.kind,
  }, String(n));
}

function sourceCard(s) {
  const where = s.headingPath?.length ? s.headingPath.join(' › ') : s.list;
  const meta = [KIND_LABEL[s.kind] || s.kind, where, s.date].filter(Boolean).join(' · ');
  const card = el('div', { class: 'cite', 'data-kind': s.kind }, [
    el('span', { class: 'cite__spine', 'aria-hidden': 'true' }),
    el('a', { class: 'cite__body', href: s.url, target: '_blank', rel: 'noopener' }, [
      el('span', { class: 'cite__n', text: String(s.n) }),
      el('span', { class: 'cite__title', text: s.title, title: s.title }),
      el('span', { class: 'cite__meta', text: meta, title: meta }),
    ]),
  ]);
  if (s.docUrl && s.docUrl !== s.url) {
    card.append(el('a', {
      class: 'cite__doc', href: s.docUrl, target: '_blank', rel: 'noopener', title: 'Open the linked document',
    }, 'Open doc'));
  }
  return card;
}

/** Sources shown under an answer: cited ones first, then (collapsed) the rest. */
function sourcesBlock(sources, answerText) {
  const cited = new Set([...answerText.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
    .flatMap((m) => m[1].split(',').map((n) => Number(n.trim()))));
  const used = sources.filter((s) => cited.has(s.n));
  const rest = sources.filter((s) => !cited.has(s.n));
  const primary = used.length ? used : sources.slice(0, 3);
  const extra = used.length ? rest : sources.slice(3);

  const block = el('div', { class: 'sources' }, [
    el('div', { class: 'sources__label', text: primary.length > 1 ? 'Sources' : 'Source' }),
    ...primary.map(sourceCard),
  ]);
  if (extra.length) {
    const more = el('details', { class: 'sources__more' }, [
      el('summary', { text: `${extra.length} more related` }),
      ...extra.map(sourceCard),
    ]);
    block.append(more);
  }
  return block;
}

// ---------------------------------------------------------------- asking

const history = [];      // [{ role, content }] — what we send to the server
let busy = false;
let controller = null;

function setBusy(on) {
  busy = on;
  $('#send').hidden = on;
  $('#stop').hidden = !on;
  if (!on) $('#send').disabled = !$('#q').value.trim();
}

async function ask(query) {
  const q = query.trim();
  if (!q || busy) return;
  if (thread().querySelector('.welcome')) thread().replaceChildren();
  addUserTurn(q);

  if (mode === 'checking') await connect();
  if (mode === 'offline') {
    // The server may have come up since the panel opened.
    const back = await connect();
    if (!back) { offlineAnswer(q); return; }
  }
  history.push({ role: 'user', content: q });
  await onlineAnswer();
}

/** Stream one answer for the last user message in `history`. */
async function onlineAnswer() {
  const turn = el('div', { class: 'turn' }, [el('div', { class: 'who', text: 'Assistant' })]);
  const status = thinking(STATUS_TEXT.retrieving);
  const answer = el('div', { class: 'answer', hidden: true });
  turn.append(status, answer);
  thread().append(turn);
  scrollDown();

  let text = '';
  let sources = [];
  let failed = null;
  controller = new AbortController();
  setBusy(true);

  const paint = () => {
    answer.hidden = !text;
    answer.replaceChildren(renderAnswer(text, (n) => citeChip(sources, n)));
    const nearBottom = thread().scrollHeight - thread().scrollTop - thread().clientHeight < 120;
    if (nearBottom) scrollDown();
  };

  await streamChat(API, history, {
    status: (d) => { status.querySelector('.thinking__text').textContent = STATUS_TEXT[d.stage] || 'Working…'; },
    sources: (d) => { sources = d; },
    token: (d) => { status.remove(); text += d.text; paint(); },
    reset: () => { text = ''; paint(); },
    error: (d) => { failed = d; },
    done: () => {},
  }, controller.signal);

  const aborted = controller.signal.aborted;
  controller = null;
  setBusy(false);
  status.remove();

  if (failed) {
    history.pop();                                   // let Retry resend the question
    if (failed.code === 'UNREACHABLE') { mode = 'offline'; connect(); }
    turn.append(errorNotice(failed, () => {
      const q = [...thread().querySelectorAll('.turn--user .bubble')].pop()?.textContent;
      turn.remove();
      if (q) { history.push({ role: 'user', content: q }); onlineAnswer(); }
    }));
    return;
  }

  if (aborted && !text) {
    history.pop();
    turn.append(el('div', { class: 'notice notice--empty' }, [el('b', { text: 'Stopped.' })]));
    return;
  }

  if (aborted) text += ' …';
  paint();
  history.push({ role: 'assistant', content: text });
  if (sources.length) turn.append(sourcesBlock(sources, text));
  scrollDown();
}

function errorNotice(err, retry) {
  const btn = el('button', { class: 'btn btn--small', type: 'button', text: 'Retry' });
  btn.addEventListener('click', retry);
  const hint = err.code === 'UNREACHABLE' ? ` Start it with npm start, or check the address in settings (${API}).` : '';
  return el('div', { class: 'notice notice--error' }, [
    el('b', { text: ERROR_TEXT[err.code] || 'Something went wrong.' }),
    ` ${err.message && err.code !== 'UNREACHABLE' ? err.message : ''}${hint}`,
    el('div', { class: 'notice__actions' }, [btn]),
  ]);
}

// ---------------------------------------------------------------- offline

/** Verbatim best match from the bundled corpus, as the pre-server panel did. */
function offlineAnswer(q) {
  const hits = OFFLINE_INDEX ? search(OFFLINE_INDEX, q) : [];
  const turn = el('div', { class: 'turn' }, [el('div', { class: 'who', text: 'Assistant · offline' })]);

  if (!hits.length) {
    turn.append(el('div', { class: 'notice notice--empty' }, [
      el('b', { text: 'Nothing in the offline copy covers that.' }),
      ' Offline search only covers list content and needs close wording. '
      + 'Start the assistant server for full-site answers.',
    ]));
    thread().append(turn);
    scrollDown();
    return;
  }

  const top = hits[0].chunk;
  const body = el('div', { class: 'answer' });
  const lines = top.x.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] === top.t) lines.shift();
  body.append(renderAnswer(lines.join('\n'), () => null));
  turn.append(body);

  turn.append(el('div', { class: 'sources' }, [
    el('div', { class: 'sources__label', text: hits.length > 1 ? 'Sources' : 'Source' }),
    ...hits.map((h, i) => sourceCard({
      n: i + 1, title: h.chunk.t, kind: h.chunk.k, list: h.chunk.l,
      headingPath: [h.chunk.c].filter(Boolean), date: h.chunk.d,
      url: h.chunk.u, docUrl: h.chunk.doc,
    })),
  ]));
  turn.append(el('div', { class: 'notice' }, [
    el('b', { text: 'Offline mode.' }),
    ' Showing site content verbatim from a bundled copy of the lists. '
    + 'Pages and documents need the assistant server.',
  ]));
  thread().append(turn);
  scrollDown();
}

// ---------------------------------------------------------------- settings

function initSettings() {
  const btn = $('#settings-btn');
  const form = $('#settings');
  const input = $('#api-url');

  const toggle = (open) => {
    form.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { input.value = API; $('#settings-status').textContent = ''; input.focus(); }
  };
  btn.addEventListener('click', () => toggle(form.hidden));
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = (input.value.trim() || DEFAULT_API).replace(/\/+$/, '');
    try { new URL(url); } catch { $('#settings-status').textContent = 'Not a valid URL.'; return; }
    API = url;
    try { await chrome.storage.local.set({ apiUrl: url }); } catch { /* keep for this session */ }
    $('#settings-status').textContent = 'Connecting…';
    const ok = await connect();
    $('#settings-status').textContent = ok ? 'Connected.' : 'Not reachable — using offline search.';
    if (ok) setTimeout(() => toggle(false), 700);
  });
}

// ---------------------------------------------------------------- init

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
}

async function init() {
  const form = $('#composer');
  const input = $('#q');
  const send = $('#send');

  input.addEventListener('input', () => {
    autoGrow(input);
    send.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const q = input.value;
    input.value = '';
    autoGrow(input);
    send.disabled = true;
    ask(q);
  });

  $('#stop').addEventListener('click', () => controller?.abort());

  $('#reset').addEventListener('click', () => {
    controller?.abort();
    showWelcome();
    input.value = '';
    autoGrow(input);
    send.disabled = true;
    input.focus();
  });

  initSettings();
  showWelcome();
  await loadSettings();
  connect();
}

init();
