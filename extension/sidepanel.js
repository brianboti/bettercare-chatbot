// BetterCare Assistant — side panel.
//
// No model and no network. This searches the corpus bundled at build time
// (data/corpus.json, generated from the extracted SharePoint lists) and shows
// the matching content verbatim with a link to the list item it came from.
// Swapping `answer()` for a call to the Claude API is the only change needed
// to make this a real assistant.

import { buildIndex, search } from './search.js';

const SUGGESTIONS = [
  { kind: 'faq',      q: 'What is Epic Haiku?' },
  { kind: 'glossary', q: 'What is SlicerDicer called in axiUm?' },
  { kind: 'catalog',  q: 'Find the cash drawer tip sheet' },
  { kind: 'feature',  q: 'What is Abridge Dictation?' },
  { kind: 'event',    q: 'When did the vAugust2024 upgrade go live?' },
];

// ---------------------------------------------------------------- utilities

const $ = (sel) => document.querySelector(sel);

/** Build an element. Children may be nodes or strings (set as text). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------------------------------------------------------------- corpus

let INDEX = null;

async function loadCorpus() {
  const res = await fetch(chrome.runtime.getURL('data/corpus.json'));
  const corpus = await res.json();
  INDEX = buildIndex(corpus);
  $('#count').textContent = `${corpus.length} items indexed`;
}

// ---------------------------------------------------------------- rendering

/** Turn a chunk's plain text into paragraphs and bullet lists. */
function renderBody(text, title) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] && lines[0] === title) lines.shift();

  const out = [];
  let bullets = null;

  const flush = () => {
    if (bullets) { out.push(el('ul', {}, bullets)); bullets = null; }
  };

  for (const line of lines) {
    if (line.startsWith('- ')) {
      (bullets ||= []).push(el('li', { text: line.slice(2) }));
    } else {
      flush();
      out.push(el('p', { text: line }));
    }
  }
  flush();
  return out;
}

function citation(chunk, n) {
  const meta = [chunk.l, chunk.c, chunk.d].filter(Boolean).join(' · ');
  return el('a', {
    class: 'cite',
    'data-kind': chunk.k,
    href: chunk.doc || chunk.u,
    target: '_blank',
    rel: 'noopener',
  }, [
    el('span', { class: 'cite__spine', 'aria-hidden': 'true' }),
    el('span', { class: 'cite__body' }, [
      el('span', { class: 'cite__n', text: String(n) }),
      el('span', { class: 'cite__title', text: chunk.t, title: chunk.t }),
      el('span', { class: 'cite__meta', text: meta }),
    ]),
  ]);
}

function thread() { return $('#thread'); }

function scrollDown() {
  const t = thread();
  t.scrollTop = t.scrollHeight;
}

function showWelcome() {
  thread().replaceChildren(
    el('div', { class: 'welcome' }, [
      el('h1', { text: 'Ask anything on the BetterCare site.' }),
      el('p', {
        text: 'Upgrades, tip sheets, training, and the axiUm → Epic glossary. '
            + 'Every answer links back to the item it came from.',
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

function addUserTurn(text) {
  thread().append(
    el('div', { class: 'turn turn--user' }, [el('div', { class: 'bubble', text })]),
  );
  scrollDown();
}

function addThinking() {
  const node = el('div', { class: 'turn' }, [
    el('div', { class: 'who', text: 'Assistant' }),
    el('div', { class: 'thinking' }, [
      el('span', { class: 'thinking__dots', 'aria-hidden': 'true' }, [
        el('i'), el('i'), el('i'),
      ]),
      el('span', { text: 'Reading the site…' }),
    ]),
  ]);
  thread().append(node);
  scrollDown();
  return node;
}

/**
 * Compose the reply. With no model in the loop this presents the matched site
 * content directly rather than paraphrasing it — which also means it can never
 * state something the site does not.
 */
function answer(hits, query) {
  const turn = el('div', { class: 'turn' }, [el('div', { class: 'who', text: 'Assistant' })]);

  if (!hits.length) {
    turn.append(
      el('div', { class: 'notice notice--empty' }, [
        el('b', { text: 'Nothing on this site covers that.' }),
        ' Try naming an Epic application (Haiku, Wisdom, Beaker, Cogito), '
        + 'an upgrade wave, or a tip sheet.',
      ]),
    );
    return turn;
  }

  const top = hits[0].chunk;

  if (top.k === 'catalog') {
    // Catalog rows are metadata about a file. Say so instead of guessing.
    turn.append(el('div', { class: 'answer' }, [
      el('p', { text: "There's a tip sheet for this, but its contents aren't indexed yet — "
                    + 'so here is the document rather than a guess at what it says.' }),
    ]));
    if (top.r?.length || top.c) {
      turn.append(el('div', { class: 'chips' },
        [...(top.r || []), top.c].filter(Boolean).map((r) => el('span', { class: 'chip', text: r }))));
    }
  } else {
    turn.append(el('div', { class: 'answer' }, renderBody(top.x, top.t)));
  }

  turn.append(
    el('div', { class: 'sources' }, [
      el('div', { class: 'sources__label', text: hits.length > 1 ? 'Sources' : 'Source' }),
      ...hits.map((h, i) => citation(h.chunk, i + 1)),
    ]),
  );

  if (top.k === 'catalog') {
    turn.append(
      el('div', { class: 'notice' }, [
        el('b', { text: 'Not yet readable.' }),
        ' Tip-sheet files are indexed by title and role only. '
        + 'Enable document indexing to get answers from inside PDFs.',
      ]),
    );
  }

  return turn;
}

// ---------------------------------------------------------------- interaction

let busy = false;

async function ask(query) {
  const q = query.trim();
  if (!q || busy) return;
  busy = true;

  // Clear the welcome panel on the first question.
  if (thread().querySelector('.welcome')) thread().replaceChildren();

  addUserTurn(q);
  const pending = addThinking();

  const hits = INDEX ? search(INDEX, q) : [];

  // A short beat so the working state is visible; the search itself is instant.
  await new Promise((r) => setTimeout(r, 260));

  pending.replaceWith(answer(hits, q));
  scrollDown();
  busy = false;
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
}

function init() {
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
    const q = input.value;
    input.value = '';
    autoGrow(input);
    send.disabled = true;
    ask(q);
  });

  $('#reset').addEventListener('click', () => {
    showWelcome();
    input.value = '';
    autoGrow(input);
    send.disabled = true;
    input.focus();
  });

  showWelcome();
  loadCorpus().catch((err) => {
    $('#count').textContent = 'corpus failed to load';
    console.error('[BetterCare]', err);
  });
}

init();
