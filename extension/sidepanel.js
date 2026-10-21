// Sophia Assistant — side panel.
//
// Online: a chat client of the Sophia RAG server (server/, `npm start`).
// Each question streams back a Claude answer grounded in the whole site —
// pages, documents and lists — with [n] citations to the SharePoint source.
//
// Offline (server unreachable): falls back to keyword search over the corpus
// bundled at build time (data/corpus.json) and shows matches verbatim.
//
// Signing in: a server with sign-in (AUTH_MODE=password, as on GCP) needs a
// session token, kept per server in chrome.storage.local and sent as
// "Authorization: Bearer". The panel first tries SharePoint sign-in (who is
// signed in to SharePoint in this browser, when the server allows it), then
// asks for a username and password. A development server (AUTH_MODE=header)
// gets this browser's anonymous id instead.

import { DEFAULT_API, health, streamChat, apiJson, apiRequest } from './lib/chat-api.js';
import { fetchSharePointUser, freshSaved } from './lib/sharepoint.js';

// Anonymous id for this browser, for development servers without sign-in.
const USER_ID = (() => {
  try {
    let id = localStorage.getItem('sophia-ext-user');
    if (!id) { id = `ext-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('sophia-ext-user', id); }
    return id;
  } catch { return null; }
})();
const CONVERSATION_ID = `c-${Date.now().toString(36)}`;

const THUMB_UP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 2.7 1.2 2.3 2.8L12.6 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>';
const THUMB_DOWN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 13V4H4v9zM7 13l4 8c1.7 0 2.7-1.2 2.3-2.8L12.6 15H19a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 17.8 4H7"/></svg>';

/** Helpful / Not helpful under an answer, then an optional comment box. */
function feedbackRow(getTurnId) {
  const thanks = el('span', { class: 'feedback__thanks', role: 'status' });
  const thanksFor = (v) => (v > 0 ? 'Thanks!' : "Thanks. This helps us fix what's missing.");
  let current = 0;
  const send = (body) => {
    const turnId = getTurnId();
    return turnId ? apiJson(API, '/api/feedback', { ...who(), body: { turnId, ...body } }) : Promise.resolve(null);
  };

  const label = el('label', { class: 'feedback__label', for: `fb-${Math.random().toString(36).slice(2, 8)}` });
  const box = el('textarea', { class: 'feedback__text', id: label.getAttribute('for'), rows: '3', maxlength: '500' });
  const err = el('span', { class: 'feedback__err', role: 'alert' });
  const skip = el('button', { class: 'btn btn--small btn--quiet', type: 'button', text: 'Skip' });
  const submit = el('button', { class: 'btn btn--small', type: 'submit', text: 'Send' });
  const form = el('form', { class: 'feedback__form', hidden: '' }, [
    label, box,
    el('div', { class: 'feedback__foot' }, [err, el('small', { text: 'Read by the Clinical IT team.' }), skip, submit]),
  ]);
  const close = (msg) => { form.hidden = true; if (msg) thanks.textContent = msg; };
  skip.addEventListener('click', () => close(thanksFor(current)));
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = box.value.trim();
    if (!note) return close(thanksFor(current));
    submit.disabled = true;
    err.textContent = '';
    const ok = await send({ value: current, note });
    submit.disabled = false;
    if (!ok) { err.textContent = "Couldn't send. Try again."; return; }
    close('Thanks, your feedback was sent.');
  });

  const mk = (value, labelText, svg) => {
    const b = el('button', { class: 'feedback__btn', type: 'button', title: labelText, 'aria-label': labelText, 'aria-pressed': 'false' });
    b.innerHTML = svg;                                       // static icon markup only
    b.addEventListener('click', () => {
      current = current === value ? 0 : value;
      for (const x of row.querySelectorAll('.feedback__btn')) x.setAttribute('aria-pressed', 'false');
      thanks.textContent = '';
      if (current) {
        b.setAttribute('aria-pressed', 'true');
        label.textContent = value > 0 ? 'What was helpful? (optional)' : 'What was wrong or missing? (optional)';
        box.placeholder = value > 0 ? 'e.g. It linked straight to the tip sheet I needed' : 'e.g. It pointed to the old version of the policy';
        box.value = '';
        err.textContent = '';
        form.hidden = false;
        box.focus();
      } else {
        close();
      }
      send({ value: current });
    });
    return b;
  };
  const row = el('div', { class: 'feedback' }, [mk(1, 'Helpful', THUMB_UP), mk(-1, 'Not helpful', THUMB_DOWN), thanks]);
  return el('div', {}, [row, form]);
}
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
  SIGN_IN_REQUIRED: 'Please sign in again.',
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
let mode = 'checking';       // 'claude' | 'retrieval-only' | 'offline' | 'checking' | 'signin'
let OFFLINE_INDEX = null;
let AUTH = { mode: 'header', methods: [] };   // the server's /api/auth/config
let SESSION = null;          // { token, user, via } on a server with sign-in

/** Who is asking, for every request: the session token, or this browser's id. */
const who = () => (AUTH.mode === 'header' ? { userId: USER_ID } : { token: SESSION?.token });

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
    AUTH = h.auth && h.auth !== 'header' ? (await apiJson(API, '/api/auth/config')) || { mode: h.auth, methods: ['password'] } : { mode: 'header', methods: [] };
    if (AUTH.mode !== 'header' && !(await ensureSignedIn())) {
      mode = 'signin';
      setScope('checking', 'Sign in to ask', '');
      showSignIn();
      return true;
    }
    mode = h.mode === 'claude' ? 'claude' : 'retrieval-only';
    setScope(mode, mode === 'claude' ? 'Connected' : 'Retrieval-only mode',
      `${Number(h.chunks).toLocaleString()} items`);
    renderAccount();
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

// ---------------------------------------------------------------- sign-in

async function savedSessions() {
  try { return (await chrome.storage.local.get('sessions')).sessions || {}; } catch { return {}; }
}
async function saveSession(s) {
  SESSION = s;
  const all = await savedSessions();
  if (s) all[API] = s; else delete all[API];
  try { await chrome.storage.local.set({ sessions: all }); } catch { /* kept for this panel only */ }
}

/** Who is signed in to SharePoint in this browser: saved by launcher.js, else asked now. */
async function sharePointUser() {
  try {
    const { spUser } = await chrome.storage.local.get('spUser');
    const saved = freshSaved(spUser);
    if (saved) return saved;
  } catch { /* storage unavailable */ }
  return fetchSharePointUser();
}

async function sharePointSignIn() {
  const sp = await sharePointUser();
  if (!sp) return { error: 'Not signed in to SharePoint in this browser. Open the BetterCare site, sign in there, and try again.' };
  const r = await apiRequest(API, '/api/auth/sharepoint', { body: sp });
  if (!r.ok) return { error: r.body?.message || `Sign-in failed (${r.status || 'server unreachable'}).` };
  await saveSession({ token: r.body.token, user: r.body.user, via: 'sharepoint' });
  return { ok: true };
}

/** A working session for this server: the saved one, else SharePoint sign-in. */
async function ensureSignedIn() {
  const saved = (await savedSessions())[API];
  if (saved?.token) {
    const r = await apiRequest(API, '/api/me', { token: saved.token });
    if (r.ok && r.body?.user) { SESSION = { ...saved, user: r.body.user }; return true; }
    if (r.status === 401) await saveSession(null);
    else if (!r.ok) { SESSION = saved; return true; }    // server trouble, not a sign-out: keep it
  }
  if (AUTH.methods?.includes('sharepoint')) return !!(await sharePointSignIn()).ok;
  return false;
}

function showSignIn(message = '') {
  history.length = 0;
  const err = el('p', { class: 'signin__error', role: 'alert', text: message, hidden: message ? null : '' });
  const user = el('input', { id: 'signin-user', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: '' });
  const pass = el('input', { id: 'signin-pass', type: 'password', autocomplete: 'current-password', required: '' });
  const submit = el('button', { class: 'btn', type: 'submit', text: 'Sign in' });
  const form = el('form', { class: 'signin' }, [
    el('h1', { text: 'Sign in to Sophia' }),
    el('p', { class: 'signin__sub', text: `The server at ${new URL(API).host} needs you to sign in.` }),
    err,
    el('label', { for: 'signin-user', text: 'Username' }), user,
    el('label', { for: 'signin-pass', text: 'Password' }), pass,
    submit,
  ]);
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const r = await apiRequest(API, '/api/auth/login', { body: { username: user.value.trim().toLowerCase(), password: pass.value, token: true } });
    submit.disabled = false;
    if (!r.ok) { fail(r.body?.message || (r.status ? `Sign-in failed (${r.status}).` : "Can't reach the server.")); pass.select(); return; }
    await saveSession({ token: r.body.token, user: r.body.user, via: 'password' });
    await connect();
    showWelcome();
  });
  const nodes = [form];
  if (AUTH.methods?.includes('sharepoint')) {
    const sp = el('button', { class: 'btn btn--quiet', type: 'button', text: 'Use my SharePoint sign-in' });
    sp.addEventListener('click', async () => {
      sp.disabled = true;
      const r = await sharePointSignIn();
      sp.disabled = false;
      if (r.error) { fail(r.error); return; }
      await connect();
      showWelcome();
    });
    nodes.push(el('div', { class: 'signin__alt' }, [sp, el('small', { text: 'Uses the account you are signed in to SharePoint with.' })]));
  }
  thread().replaceChildren(...nodes);
  user.focus();
}

async function signOut() {
  if (SESSION?.token) await apiRequest(API, '/api/auth/logout', { token: SESSION.token, body: {} });
  await saveSession(null);
  renderAccount();
  mode = 'signin';
  setScope('checking', 'Sign in to ask', '');
  showSignIn();
}

/** The settings panel's account line. */
function renderAccount() {
  const box = $('#account');
  if (!box) return;
  if (AUTH.mode === 'header' || !SESSION?.user) { box.hidden = true; return; }
  const u = SESSION.user;
  const out = el('button', { class: 'btn btn--small btn--quiet', type: 'button', text: 'Sign out' });
  out.addEventListener('click', signOut);
  box.replaceChildren(el('span', { text: `Signed in as ${u.name || u.id}${SESSION.via === 'sharepoint' ? ' (from SharePoint)' : ''}` }), out);
  box.hidden = false;
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
  const when = s.date || (s.updated ? `Updated ${s.updated}` : null);
  const meta = [KIND_LABEL[s.kind] || s.kind, where, when].filter(Boolean).join(' · ');
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

/** Sources shown under an answer: cited ones first, then (collapsed) the rest, then older ones. */
function sourcesBlock(sources, answerText) {
  const cited = new Set([...answerText.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
    .flatMap((m) => m[1].split(',').map((n) => Number(n.trim()))));
  // Sources arrive newest first; much older ones go under "Older results".
  const current = sources.filter((s) => !s.older);
  const older = sources.filter((s) => s.older);
  const used = current.filter((s) => cited.has(s.n));
  const primary = used.length ? used : current.slice(0, 3);
  const extra = current.filter((s) => !primary.includes(s));

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
  if (older.length) {
    block.append(el('details', { class: 'sources__more' }, [
      el('summary', { text: `Older results (${older.length})` }),
      ...older.map(sourceCard),
    ]));
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
  if (mode === 'signin') { showSignIn('Sign in first, then ask again.'); return; }
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
  let assumed = [];
  let sources = [];
  let failed = null;
  let turnId = null;
  controller = new AbortController();
  setBusy(true);

  const paint = () => {
    answer.hidden = !text;
    answer.replaceChildren(
      ...(assumed.length ? [el('p', { class: 'assume', text: `Assuming: ${assumed.map((a) => a.text).join(' · ')}` })] : []),
      renderAnswer(text, (n) => citeChip(sources, n)),
    );
    const nearBottom = thread().scrollHeight - thread().scrollTop - thread().clientHeight < 120;
    if (nearBottom) scrollDown();
  };

  await streamChat(API, history, {
    status: (d) => { status.querySelector('.thinking__text').textContent = STATUS_TEXT[d.stage] || 'Working…'; },
    sources: (d) => { sources = d; },
    assumptions: (a) => { assumed = a; paint(); },
    token: (d) => { status.remove(); text += d.text; paint(); },
    answer: (d) => { text = d.text; paint(); },
    reset: () => { text = ''; assumed = []; paint(); },
    error: (d) => { failed = d; },
    done: (d) => { turnId = d.turnId ?? null; },
  }, controller.signal, { ...who(), conversationId: CONVERSATION_ID });

  const aborted = controller.signal.aborted;
  controller = null;
  setBusy(false);
  status.remove();

  if (failed) {
    history.pop();                                   // let Retry resend the question
    if (failed.code === 'UNREACHABLE') { mode = 'offline'; connect(); }
    if (failed.code === 'SIGN_IN_REQUIRED') { await saveSession(null); mode = 'signin'; showSignIn('Your sign-in ended. Please sign in again.'); return; }
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
  history.push({ role: 'assistant', content: assumed.length ? `(Assumed: ${assumed.map((a) => a.text).join('; ')})\n\n${text}` : text });
  turn.append(feedbackRow(() => turnId));
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
    // A server outside the built-in list (localhost, *.run.app): ask Chrome
    // for access to it. Asked first, while this click still counts as the
    // user gesture Chrome requires. Declined or not grantable: the server's
    // CORS headers may still allow it.
    const asked = chrome.permissions?.request({ origins: [`${new URL(url).origin}/*`] }).catch(() => false);
    API = url;
    try { await chrome.storage.local.set({ apiUrl: url }); } catch { /* keep for this session */ }
    await asked;
    $('#settings-status').textContent = 'Connecting…';
    SESSION = null;
    const ok = await connect();
    if (ok && mode !== 'signin') showWelcome();
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
