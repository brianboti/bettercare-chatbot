// Sophia insights dashboard (admins only).
//
// Reads GET /api/admin/insights and manages pushed content through
// /api/admin/promotions. Identity is the replica's demo sign-in: the user id
// in localStorage 'sophia-user', sent as X-Sophia-User. All data is rendered
// with textContent; nothing from the API goes through innerHTML.

const USER_KEY = 'sophia-user';
const main = document.getElementById('main');
const tip = document.getElementById('tip');
const daysSel = document.getElementById('days');
const roleSel = document.getElementById('role');

const state = { userId: readUserId(), days: 30, role: '', data: null, roles: new Map(), editing: null, flash: null, fbFilter: 'all' };

// ---------------------------------------------------------------- utilities

function readUserId() {
  let raw = null;
  try { raw = localStorage.getItem(USER_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v === 'string') return v;
    return v?.id || null;
  } catch { return raw; }
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) n.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.userId ? { 'X-Sophia-User': state.userId } : {}), ...opts.headers },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = new Error(body?.message || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return body;
}

const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const roleLabel = (r) => state.roles.get(r) || (r === 'unknown' || !r ? 'Unknown role' : r);
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtDate = (d) => (d ? fmtDay(d) : null);

// ---------------------------------------------------------------- tooltip

function showTip(e, lines) {
  tip.replaceChildren(...lines.map((l, i) => (i === 0 ? el('b', { text: l }) : el('div', { text: l }))));
  tip.hidden = false;
  const pad = 12;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------------------------------------------------------------- sign in

async function signIn(message) {
  document.getElementById('controls').hidden = true;
  let users = [];
  try { users = (await api('/api/demo-users')).users || []; } catch { /* server down */ }
  const admins = users.filter((u) => u.isAdmin);
  const sel = el('select', { id: 'signinUser', 'aria-label': 'Admin account' },
    (admins.length ? admins : users).map((u) => el('option', { value: u.id, text: `${u.name || u.id}${u.department ? ` — ${u.department}` : ''}` })));
  main.replaceChildren(el('section', { class: 'card signin' }, [
    el('h2', { text: 'Sign in as an admin' }),
    el('p', { text: message || 'This dashboard is for Clinical IT. Choose an admin account from the demo sign-in.' }),
    users.length
      ? el('div', { class: 'row' }, [sel, el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Sign in',
        onclick: () => {
          try { localStorage.setItem(USER_KEY, JSON.stringify({ id: sel.value })); } catch { /* storage blocked */ }
          location.reload();
        },
      })])
      : el('p', { class: 'muted', text: "Can't reach the Sophia server. Is `npm start` running?" }),
  ]));
}

// ---------------------------------------------------------------- load

// ---------------------------------------------------------------- tabs

const currentTab = () => (location.hash === '#tests' ? 'tests' : 'insights');

function route() {
  const tab = currentTab();
  for (const a of document.querySelectorAll('#tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const n of document.querySelectorAll('[data-insights]')) n.hidden = tab !== 'insights';
  document.title = tab === 'tests' ? 'Sophia tests' : 'Sophia insights';
  clearTimeout(tests.poll);
  return tab === 'tests' ? loadTests() : load();
}
addEventListener('hashchange', route);

async function load() {
  if (!state.userId) return signIn();
  if (currentTab() !== 'insights') return;
  main.setAttribute('aria-busy', 'true');
  try {
    const q = new URLSearchParams({ days: String(state.days) });
    if (state.role) q.set('role', state.role);
    const data = await api(`/api/admin/insights?${q}`);
    state.data = data;
    state.roles = new Map((data.roles || []).map((r) => [r.key, r.label]));
    fillRoleSelect(data.roles || []);
    document.getElementById('controls').hidden = false;
    document.getElementById('tabs').hidden = false;
    document.getElementById('demoBadge').hidden = !data.demoData;
    document.getElementById('who').textContent = `Signed in as ${state.userId}`;
    render();
  } catch (e) {
    if (e.status === 403) return signIn(`${state.userId} isn't an admin. Choose an admin account.`);
    main.replaceChildren(el('section', { class: 'card' }, [el('h2', { text: "Couldn't load insights" }), el('p', { class: 'muted', text: e.message })]));
  } finally {
    main.removeAttribute('aria-busy');
  }
}

function fillRoleSelect(roles) {
  if (roleSel.options.length > 1) return;
  for (const r of roles) roleSel.append(el('option', { value: r.key, text: r.label }));
  roleSel.value = state.role;
}

daysSel.addEventListener('change', () => { state.days = Number(daysSel.value); load(); });
roleSel.addEventListener('change', () => { state.role = roleSel.value; load(); });

// ---------------------------------------------------------------- render

const resizers = [];
function render() {
  const d = state.data;
  resizers.length = 0;
  const scope = state.role ? ` · ${roleLabel(state.role)}` : '';

  main.replaceChildren(
    kpis(d),
    card(`Questions per day${scope}`, `Last ${d.days} days`, daily(d)),
    el('div', { class: 'grid-2' }, [
      card('What people ask about', 'Topics, by number of questions', topicBars(d)),
      card('Topics by role', "Shade = share of that role's questions", heatmap(d)),
    ]),
    card('Where people are struggling', 'Weak matches, thumbs down, questions asked again in other words, and errors — newest first', trouble(d), 'card--key'),
    card('What people said', 'Every thumbs up and down, with the comment the person left — newest first', feedback(d)),
    el('div', { class: 'grid-2' }, [
      card('Most asked', 'Same question, any wording case. Share = part of all questions asked in this period.', topQuestions(d)),
      card('Where people end up', 'Sources opened from answers', opened(d)),
    ]),
    card('Recent questions', 'Newest first', recent(d)),
    card('Pushed content', 'What Clinical IT wants people to see. Shown as suggestion cards on Sophia’s welcome screen for the chosen roles.', promotions(d)),
  );
}

function card(title, hint, body, extra = '') {
  return el('section', { class: `card ${extra}` }, [
    el('div', { class: 'card-head' }, [el('h2', { text: title }), hint ? el('p', { class: 'hint', text: hint }) : null]),
    body,
  ]);
}

// ---------------------------------------------------------------- KPIs

function kpis(d) {
  const t = d.totals;
  const rated = t.up + t.down;
  const tile = (label, value, detail) => el('div', { class: 'kpi' }, [el('span', { class: 'l', text: label }), el('span', { class: 'v', text: value }), el('span', { class: 'd', text: detail })]);
  return el('div', { class: 'kpis' }, [
    tile('Questions', fmtN(t.questions), `${(t.questions / d.days).toFixed(1)} a day on average`),
    tile('People', fmtN(t.users), 'asked at least one question'),
    tile('Satisfaction', pct(t.up, rated), rated ? `${fmtN(t.up)} helpful · ${fmtN(t.down)} not helpful` : 'no ratings yet'),
    tile("Couldn't find it", fmtN(t.lowConfidence + t.rephrased), `${fmtN(t.lowConfidence)} weak matches · ${fmtN(t.rephrased)} asked again${t.errors ? ` · ${fmtN(t.errors)} errors` : ''}`),
  ]);
}

// ---------------------------------------------------------------- daily bars

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function daily(d) {
  // Fill every day in the window, including days with no questions.
  const counts = new Map(d.byDay.map((x) => [x.day, x.count]));
  const days = [];
  const today = new Date();
  for (let i = d.days - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    days.push({ day, count: counts.get(day) || 0 });
  }
  const wrap = el('div', { class: 'chart', role: 'img', 'aria-label': `Questions per day over the last ${d.days} days` });
  const draw = () => {
    const W = Math.max(300, wrap.clientWidth || 800), H = 190;
    const m = { l: 34, r: 6, t: 8, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(1, ...days.map((x) => x.count)));
    const y = (v) => m.t + ih - (v / max) * ih;
    const step = iw / days.length;
    const gap = days.length > 60 ? 1 : 2;
    const bw = Math.max(1, step - gap);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const ticks = 4;
    const g = svg('g', { class: 'axis' });
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i;
      g.append(svg('line', { class: i ? 'gridline' : 'baseline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
      g.append(t);
    }
    const every = Math.ceil(days.length / Math.max(2, Math.floor(iw / 70)));
    days.forEach((x, i) => {
      if ((days.length - 1 - i) % every !== 0) return;
      const t = svg('text', { x: m.l + i * step + step / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = fmtDay(x.day);
      g.append(t);
    });
    s.append(g);
    days.forEach((x, i) => {
      const x0 = m.l + i * step + gap / 2;
      const hgt = y(0) - y(x.count);
      const hit = svg('rect', { class: 'hit', x: m.l + i * step, y: m.t, width: step, height: ih });
      const r = Math.min(4, bw / 2, hgt);
      // Rounded at the data end, square on the baseline.
      const bar = x.count ? svg('path', {
        class: 'bar',
        d: `M${x0},${y(0)} V${y(x.count) + r} Q${x0},${y(x.count)} ${x0 + r},${y(x.count)} H${x0 + bw - r} Q${x0 + bw},${y(x.count)} ${x0 + bw},${y(x.count) + r} V${y(0)} Z`,
      }) : null;
      hit.addEventListener('mousemove', (e) => { bar?.classList.add('on'); showTip(e, [fmtDay(x.day), `${fmtN(x.count)} question${x.count === 1 ? '' : 's'}`]); });
      hit.addEventListener('mouseleave', () => { bar?.classList.remove('on'); hideTip(); });
      s.append(hit);
      if (bar) s.append(bar);
    });
    wrap.replaceChildren(s);
  };
  resizers.push(draw);
  setTimeout(draw, 0);   // after the card is in the DOM (rAF would stall in a background tab)

  const table = el('details', { class: 'tbl' }, [
    el('summary', { text: 'View as table' }),
    el('div', { class: 'tbl-wrap' }, el('table', { class: 'data' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Day' }), el('th', { class: 'num', text: 'Questions' })])),
      el('tbody', {}, days.slice().reverse().map((x) => el('tr', {}, [el('td', { text: fmtDay(x.day) }), el('td', { class: 'num', text: fmtN(x.count) })]))),
    ])),
  ]);
  return el('div', {}, [wrap, table]);
}

// ---------------------------------------------------------------- topics

function topicBars(d) {
  if (!d.topics.length) return el('p', { class: 'empty', text: 'No questions in this period.' });
  const list = d.topics.slice(0, 12);
  const max = list[0].count;
  const total = d.topics.reduce((a, t) => a + t.count, 0);
  return el('div', { class: 'hbars' }, list.map((t) => {
    const row = el('div', { class: 'hbar' }, [
      el('span', { class: 'n', text: t.topic }),
      el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(t.count / max) * 100}%` })),
      el('span', { class: 'v', text: fmtN(t.count) }),
    ]);
    row.addEventListener('mousemove', (e) => showTip(e, [t.topic, `${fmtN(t.count)} questions`, `${pct(t.count, total)} of topic mentions`]));
    row.addEventListener('mouseleave', hideTip);
    return row;
  }));
}

function heatmap(d) {
  if (!d.topicRole.length) return el('p', { class: 'empty', text: 'No questions in this period.' });
  const topics = d.topics.slice(0, 10).map((t) => t.topic);
  const roleTotals = new Map();
  for (const x of d.topicRole) roleTotals.set(x.role, (roleTotals.get(x.role) || 0) + x.count);
  const roles = [...roleTotals.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const val = new Map(d.topicRole.map((x) => [`${x.topic}\u0000${x.role}`, x.count]));
  let maxShare = 0;
  for (const t of topics) for (const r of roles) maxShare = Math.max(maxShare, (val.get(`${t}\u0000${r}`) || 0) / roleTotals.get(r));

  const table = el('table', { class: 'heat' }, [
    el('thead', {}, el('tr', {}, [el('th', { text: '' }), ...roles.map((r) => el('th', { scope: 'col', text: roleLabel(r) }))])),
    el('tbody', {}, topics.map((t) => el('tr', {}, [
      el('th', { scope: 'row', text: t }),
      ...roles.map((r) => {
        const n = val.get(`${t}\u0000${r}`) || 0;
        const share = n / roleTotals.get(r);
        const k = maxShare ? share / maxShare : 0;
        const p = Math.round(8 + k * 92);
        const td = el('td', {
          class: n ? (p > 58 ? 'dark' : '') : 'zero',
          style: n ? `background: color-mix(in oklab, var(--bar) ${p}%, var(--heat-0))` : null,
          text: n ? fmtN(n) : '·',
        });
        td.addEventListener('mousemove', (e) => showTip(e, [`${roleLabel(r)} · ${t}`, `${fmtN(n)} question${n === 1 ? '' : 's'}`, `${pct(n, roleTotals.get(r))} of this role's topic mentions`]));
        td.addEventListener('mouseleave', hideTip);
        return td;
      }),
    ]))),
  ]);
  const legend = el('div', { class: 'legend-ramp' }, [
    el('span', { text: 'Less' }),
    el('span', { class: 'ramp', style: 'background: linear-gradient(90deg, color-mix(in oklab, var(--bar) 8%, var(--heat-0)), var(--bar))' }),
    el('span', { text: 'More of that role’s questions' }),
  ]);
  return el('div', {}, [el('div', { class: 'heat-wrap' }, table), legend]);
}

// ---------------------------------------------------------------- tables

const REASON = {
  'weak match': ['pill--weak', 'Weak match'],
  'thumbs down': ['pill--down', 'Thumbs down'],
  'asked again': ['pill--again', 'Asked again'],
  error: ['pill--error', 'Error'],
};

function topicTags(topics) {
  return topics?.length ? el('div', { class: 'topics' }, topics.map((t) => el('span', { class: 'topic', text: t }))) : null;
}

function dataTable(head, rows, empty) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  return el('div', { class: 'tbl-wrap' }, el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, head.map(([label, cls]) => el('th', { class: cls, text: label })))),
    el('tbody', {}, rows),
  ]));
}

function trouble(d) {
  return dataTable(
    [['When'], ['Role'], ['Question'], ['Why it’s here'], ['Match', 'num']],
    d.trouble.map((t) => el('tr', {}, [
      el('td', { class: 'when', text: fmtWhen(t.at) }),
      el('td', { class: 'role', text: roleLabel(t.role) }),
      el('td', { class: 'q' }, [el('div', { text: t.question }), topicTags(t.topics), t.note ? el('div', { class: 'note', text: `“${t.note}”` }) : null]),
      el('td', {}, el('div', { class: 'pills' }, t.reasons.map((r) => { const [cls, label] = REASON[r] || ['pill--weak', r]; return el('span', { class: `pill ${cls}`, text: label }); }))),
      el('td', { class: 'num', title: 'Best meaning-match score for the question (below 0.69 counts as weak)', text: t.confidence != null ? t.confidence.toFixed(2) : '—' }),
    ])),
    'Nothing flagged in this period.',
  );
}

const FB_FILTERS = [
  ['all', 'All', () => true],
  ['down', 'Not helpful', (f) => f.value < 0],
  ['up', 'Helpful', (f) => f.value > 0],
  ['comments', 'With comments', (f) => !!f.note],
];

function feedback(d) {
  const list = d.feedback || [];
  const body = el('div', { class: 'feed' });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const paint = () => {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.key === state.fbFilter));
    const keep = FB_FILTERS.find(([k]) => k === state.fbFilter)[2];
    body.replaceChildren(dataTable(
      [['When'], ['Role'], ['Rating'], ['Question and comment']],
      list.filter(keep).map((f) => el('tr', {}, [
        el('td', { class: 'when', text: fmtWhen(f.at) }),
        el('td', { class: 'role', text: roleLabel(f.role) }),
        el('td', {}, f.value > 0 ? el('span', { class: 'pill pill--up', text: 'Helpful' }) : el('span', { class: 'pill pill--down', text: 'Not helpful' })),
        el('td', { class: 'q' }, [
          el('div', { text: f.question }),
          topicTags(f.topics),
          f.note ? el('blockquote', { class: 'comment', text: f.note }) : el('div', { class: 'muted small', text: 'No comment' }),
          f.answer ? el('details', { class: 'tbl answer' }, [el('summary', { text: 'Sophia’s answer' }), el('div', { class: 'answer-text', text: f.answer })]) : null,
        ]),
      ])),
      list.length ? 'Nothing matches this filter.' : 'No ratings in this period.',
    ));
  };
  for (const [key, label, keep] of FB_FILTERS) {
    seg.append(el('button', {
      type: 'button', class: 'seg-btn', 'data-key': key, text: `${label} (${fmtN(list.filter(keep).length)})`,
      onclick: () => { state.fbFilter = key; paint(); },
    }));
  }
  paint();
  return el('div', {}, [seg, body]);
}

function opened(d) {
  return dataTable(
    [['Source'], ['Opens', 'num']],
    d.opened.map((o) => el('tr', {}, [
      el('td', {}, [
        o.url ? el('a', { href: o.url, target: '_blank', rel: 'noopener', text: o.title }) : el('span', { text: o.title }),
        o.kind ? el('div', { class: 'kind', text: o.kind }) : null,
      ]),
      el('td', { class: 'num', text: fmtN(o.count) }),
    ])),
    'No sources opened in this period.',
  );
}

function topQuestions(d) {
  const top = d.topQuestions[0]?.share || 1;
  const sharePct = (x) => { const p = x * 100; return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`; };
  return dataTable(
    [['Question'], ['Asked by'], ['Times', 'num'], ['Share', 'num']],
    d.topQuestions.map((q) => {
      const bar = el('span', { class: 'share-fill' });
      bar.style.width = `${(q.share / top) * 100}%`;
      return el('tr', {}, [
        el('td', { class: 'q' }, [el('div', { text: q.question }), topicTags(q.topics)]),
        el('td', { class: 'role', text: q.roles.map(roleLabel).join(', ') }),
        el('td', { class: 'num', text: fmtN(q.count) }),
        el('td', { class: 'num share', title: `${fmtN(q.count)} of ${fmtN(d.totals.questions)} questions in this period` }, [
          el('span', { class: 'share-track', 'aria-hidden': 'true' }, bar), sharePct(q.share),
        ]),
      ]);
    }),
    'No questions in this period.',
  );
}

function recent(d) {
  const table = dataTable(
    [['When'], ['Role'], ['Question'], ['Outcome']],
    d.recent.map((t) => el('tr', {}, [
      el('td', { class: 'when', text: fmtWhen(t.at) }),
      el('td', { class: 'role', text: roleLabel(t.role) }),
      el('td', { class: 'q' }, [el('div', { text: t.question }), topicTags(t.topics), t.note ? el('div', { class: 'note', text: `“${t.note}”` }) : null]),
      el('td', {}, el('div', { class: 'pills' }, [
        t.feedback > 0 ? el('span', { class: 'fb-up', text: 'Helpful' }) : null,
        t.feedback < 0 ? el('span', { class: 'pill pill--down', text: 'Not helpful' }) : null,
        t.lowConfidence ? el('span', { class: 'pill pill--weak', text: 'Weak match' }) : null,
        !t.feedback && !t.lowConfidence ? el('span', { class: 'muted', text: '—' }) : null,
      ])),
    ])),
    'No questions in this period.',
  );
  return el('div', { class: 'feed' }, table);
}

// ---------------------------------------------------------------- promotions

const EMPTY_PROMO = { title: '', blurb: '', prompt: '', url: '', roles: [], starts: '', ends: '', priority: 0, active: true };

function promotions(d) {
  const list = d.promotions || [];
  const confirmSlot = el('div');
  const rows = list.map((p) => {
    const audience = p.roles.length ? p.roles.map(roleLabel).join(', ') : 'Everyone';
    const dates = p.starts || p.ends ? `${fmtDate(p.starts) || 'Now'} – ${fmtDate(p.ends) || 'no end'}` : 'Always';
    const toggle = el('input', { type: 'checkbox', checked: p.active, 'aria-label': `Show "${p.title}"` });
    toggle.addEventListener('change', () => {
      if (!toggle.checked) {
        // Turning off hides it from everyone: confirm in the page.
        toggle.checked = true;
        confirmSlot.replaceChildren(el('div', { class: 'confirm', role: 'alert' }, [
          el('span', { text: `Stop showing “${p.title}” to ${audience === 'Everyone' ? 'everyone' : audience}?` }),
          el('button', { class: 'btn', type: 'button', text: 'Stop showing', onclick: () => savePromo({ ...p, active: false }, `Stopped showing “${p.title}”.`) }),
          el('button', { class: 'btn btn--link', type: 'button', text: 'Keep it', onclick: () => confirmSlot.replaceChildren() }),
        ]));
      } else {
        savePromo({ ...p, active: true }, `“${p.title}” is showing again.`);
      }
    });
    return el('tr', {}, [
      el('td', { class: 'q' }, [
        el('div', { class: 'promo-title', text: p.title }),
        p.blurb ? el('div', { class: 'promo-blurb', text: p.blurb }) : null,
        el('div', { class: 'promo-prompt', text: `Asks: ${p.prompt}` }),
        p.url ? el('div', { class: 'promo-prompt' }, ['Link: ', el('a', { href: p.url, target: '_blank', rel: 'noopener', text: p.url.replace(/^https:\/\//, '').slice(0, 60) }), ` · opened ${fmtN(p.linkOpens)} time${p.linkOpens === 1 ? '' : 's'}`]) : null,
      ]),
      el('td', { class: 'role', text: audience }),
      el('td', { class: 'when', text: dates }),
      el('td', { class: 'num', text: fmtN(p.shown) }),
      el('td', { class: 'num', text: fmtN(p.clicked) }),
      el('td', { class: 'num', text: pct(p.clicked, p.shown) }),
      el('td', {}, el('label', { class: 'switch' }, [toggle, p.active ? 'On' : 'Off'])),
      el('td', {}, el('button', { class: 'btn btn--link', type: 'button', text: 'Edit', onclick: () => { state.editing = { ...EMPTY_PROMO, ...p }; render(); document.getElementById('promoTitle')?.focus(); } })),
    ]);
  });

  const table = dataTable(
    [['Content'], ['Audience'], ['Dates'], ['Shown', 'num'], ['Clicked', 'num'], ['Click rate', 'num'], ['Showing'], ['']],
    rows,
    'Nothing pushed yet. Add something with the form.',
  );
  const flash = state.flash ? el('p', { class: `msg ${state.flash.ok ? 'ok' : 'err'}`, role: 'status', text: state.flash.text }) : null;
  state.flash = null;
  return el('div', { class: 'promo-grid' }, [el('div', {}, [flash, confirmSlot, table]), promoForm()]);
}

function promoForm() {
  const p = state.editing || EMPTY_PROMO;
  const editing = !!p.id;
  const msg = el('span', { class: 'msg', role: 'status' });
  const f = (label, input, help) => el('label', { class: 'f' }, [label, input, help ? el('span', { class: 'muted', style: 'font-weight:400', text: help }) : null]);
  const title = el('input', { type: 'text', id: 'promoTitle', name: 'title', value: p.title, maxlength: '120', required: true });
  const blurb = el('input', { type: 'text', id: 'promoBlurb', name: 'blurb', value: p.blurb || '', maxlength: '400' });
  const link = el('input', { type: 'url', id: 'promoUrl', name: 'url', value: p.url || '', maxlength: '1000', placeholder: 'https://uthealthsa.sharepoint.com/sites/BetterCare/…', inputmode: 'url' });
  const prompt = el('textarea', { id: 'promoPrompt', name: 'prompt', rows: '2', maxlength: '300', required: true });
  prompt.value = p.prompt;
  const starts = el('input', { type: 'date', id: 'promoStarts', name: 'starts', value: p.starts || '' });
  const ends = el('input', { type: 'date', id: 'promoEnds', name: 'ends', value: p.ends || '' });
  const priority = el('input', { type: 'number', id: 'promoPriority', name: 'priority', value: String(p.priority ?? 0), min: '0', max: '10', step: '1' });
  const active = el('input', { type: 'checkbox', id: 'promoActive', name: 'active', checked: p.active !== false });
  const roleBoxes = [...state.roles.entries()].map(([key, label]) => el('label', {}, [el('input', { type: 'checkbox', name: 'roles', value: key, id: `promoRole-${key}`, checked: p.roles.includes(key) }), label]));

  const form = el('form', { class: 'promo', novalidate: true }, [
    el('h3', { text: editing ? 'Edit pushed content' : 'Push new content' }),
    f('Title', title),
    f('Short description', blurb, 'Optional. Helps Sophia phrase the suggestion.'),
    f('What Sophia is asked when someone clicks it', prompt, 'Write it as the person would ask, e.g. “What changes for nurses in vMay2026?”'),
    f('Link (optional)', link, 'The page, document or sign-up form you’re pushing. Shown as “Open” on the card and at the top of Sophia’s answer.'),
    el('fieldset', {}, [el('legend', { text: 'Audience (none checked = everyone)' }), el('div', { class: 'checks' }, roleBoxes)]),
    el('div', { class: 'row' }, [f('Starts', starts), f('Ends', ends), f('Priority (0–10)', priority)]),
    el('label', { class: 'switch' }, [active, 'Showing']),
    el('div', { class: 'form-actions' }, [
      el('button', { class: 'btn btn--primary', type: 'submit', text: editing ? 'Save changes' : 'Push content' }),
      editing ? el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { state.editing = null; render(); } }) : null,
      msg,
    ]),
  ]);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!title.value.trim() || !prompt.value.trim()) {
      msg.className = 'msg err';
      msg.textContent = 'Add a title and the question Sophia should be asked.';
      (title.value.trim() ? prompt : title).focus();
      return;
    }
    if (link.value.trim() && !/^https:\/\/\S+$/i.test(link.value.trim())) {
      msg.className = 'msg err';
      msg.textContent = 'The link must be a full web address starting with https://';
      link.focus();
      return;
    }
    if (starts.value && ends.value && ends.value < starts.value) {
      msg.className = 'msg err';
      msg.textContent = 'The end date is before the start date.';
      ends.focus();
      return;
    }
    const body = {
      title: title.value.trim(), blurb: blurb.value.trim(), prompt: prompt.value.trim(),
      roles: roleBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
      starts: starts.value || null, ends: ends.value || null,
      priority: Number(priority.value) || 0, active: active.checked, url: link.value.trim() || null,
    };
    if (editing) body.id = p.id;
    savePromo(body, editing ? `Saved “${body.title}”.` : `Pushed “${body.title}”.`, msg);
  });
  return form;
}

async function savePromo(p, okText, msgEl) {
  const body = {
    ...(p.id ? { id: p.id } : {}),
    title: p.title, blurb: p.blurb || '', prompt: p.prompt, roles: p.roles || [],
    starts: p.starts || null, ends: p.ends || null, priority: p.priority ?? 0, active: p.active !== false, url: p.url || null,
  };
  try {
    await api('/api/admin/promotions', { method: 'POST', body: JSON.stringify(body) });
    state.editing = null;
    state.flash = { ok: true, text: okText };
    await load();
  } catch (e) {
    if (msgEl) { msgEl.className = 'msg err'; msgEl.textContent = `Couldn't save: ${e.message}`; }
    else { state.flash = { ok: false, text: `Couldn't save: ${e.message}` }; render(); }
  }
}

// ---------------------------------------------------------------- boot

let rt = 0;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => resizers.forEach((f) => f()), 120); });
addEventListener('scroll', hideTip, { passive: true });

// ---------------------------------------------------------------- tests tab

const tests = { data: null, poll: 0, filter: new Map(), open: new Set(), err: null };

const STATUS = {
  passed: ['pill--up', 'Passing'],
  failed: ['pill--down', 'Failing'],
  error: ['pill--down', "Didn't run"],
  running: ['pill--weak', 'Running…'],
  never: ['pill--neutral', 'Not run yet'],
};

const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

async function loadTests() {
  if (!state.userId) return signIn();
  clearTimeout(tests.poll);
  try {
    tests.data = await api('/api/admin/tests');
    tests.err = null;
  } catch (e) {
    if (e.status === 403) return signIn(`${state.userId} isn't an admin. Choose an admin account.`);
    tests.err = e.message;
  }
  document.getElementById('controls').hidden = false;
  document.getElementById('tabs').hidden = false;
  document.getElementById('who').textContent = `Signed in as ${state.userId}`;
  if (currentTab() !== 'tests') return;
  renderTests();
  if (tests.data?.suites.some((s) => s.run?.status === 'running')) tests.poll = setTimeout(loadTests, 1500);
}

async function runSuites(keys) {
  try {
    for (const suite of keys) await api('/api/admin/tests/run', { method: 'POST', body: JSON.stringify({ suite }) });
  } catch (e) { tests.err = e.message; }
  loadTests();
}

function renderTests() {
  if (tests.err && !tests.data) {
    main.replaceChildren(card("Couldn't load tests", null, el('p', { class: 'muted', text: tests.err })));
    return;
  }
  const suites = tests.data.suites;
  const free = suites.filter((s) => !/Claude/.test(s.cost)).map((s) => s.key);
  const anyRunning = suites.some((s) => s.run?.status === 'running');
  const totals = suites.reduce((a, s) => { a.p += s.run?.summary?.passed || 0; a.t += s.run?.summary?.total || 0; return a; }, { p: 0, t: 0 });

  main.replaceChildren(
    el('section', { class: 'card tests-intro' }, [
      el('div', { class: 'card-head' }, [
        el('div', {}, [
          el('h2', { text: 'Automated tests' }),
          el('p', { class: 'hint', text: 'Every check that runs before a change ships. Run them here and see each one pass or fail, with what it checks.' }),
        ]),
        el('div', { class: 'form-actions' }, [
          totals.t ? el('span', { class: 'muted', text: `${fmtN(totals.p)} of ${fmtN(totals.t)} checks passing in the latest runs` }) : null,
          el('button', { class: 'btn btn--primary', type: 'button', disabled: anyRunning, text: 'Run free tests', title: 'Unit tests and search accuracy. The on-topic test calls Claude, so it runs on its own button.', onclick: () => runSuites(free) }),
        ]),
      ]),
      tests.err ? el('p', { class: 'msg err', role: 'alert', text: tests.err }) : null,
    ]),
    el('div', { class: 'suite-tiles' }, suites.map(suiteTile)),
    ...suites.filter((s) => s.run?.groups?.length || s.run?.log).map(suiteDetail),
  );
}

function statusPill(run) {
  const [cls, label] = STATUS[run?.status || 'never'];
  return el('span', { class: `pill ${cls}`, text: label });
}

function suiteTile(s) {
  const r = s.run;
  const running = r?.status === 'running';
  const big = running
    ? `${fmtN(r.progress?.done || 0)} checked…`
    : r?.summary?.total ? `${fmtN(r.summary.passed)} / ${fmtN(r.summary.total)}` : '—';
  return el('section', { class: `suite-tile suite-tile--${r?.status || 'never'}` }, [
    el('div', { class: 'suite-top' }, [el('h3', { text: s.label }), statusPill(r)]),
    el('div', { class: 'suite-big' }, [
      el('span', { class: 'v', text: big }),
      !running && r?.summary?.total ? el('span', { class: 'd', text: 'passed' }) : null,
    ]),
    r?.summary?.total ? progressBar(r.summary) : null,
    el('p', { class: 'suite-desc', text: s.description }),
    el('div', { class: 'suite-foot' }, [
      el('span', { class: 'muted', text: running ? `Started ${fmtWhen(r.startedAt)}` : r?.finishedAt ? `Last run ${fmtWhen(r.finishedAt)} · took ${fmtDur(r.durationMs)}` : s.cost }),
      el('button', { class: 'btn', type: 'button', disabled: running, text: running ? 'Running…' : 'Run', title: s.cost, onclick: () => runSuites([s.key]) }),
    ]),
    r?.finishedAt ? el('p', { class: 'muted small', text: s.cost }) : null,
  ]);
}

function progressBar({ passed, total }) {
  const bar = el('div', { class: 'passbar', role: 'img', 'aria-label': `${passed} of ${total} passed` });
  const ok = el('div', { class: 'passbar-ok' });
  ok.style.width = `${(passed / total) * 100}%`;
  bar.append(ok);
  return bar;
}

const leafCases = (cases) => cases.flatMap((c) => (c.children?.length ? leafCases(c.children) : [c]));

function suiteDetail(s) {
  const r = s.run;
  const filter = tests.filter.get(s.key) || 'all';
  const body = el('div', { class: 'groups' });
  const failedCount = r.summary?.failed || 0;
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [
    ['all', `All (${fmtN(r.summary?.total || 0)})`], ['failed', `Failed (${fmtN(failedCount)})`],
  ].map(([key, label]) => el('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(key === filter), text: label,
    onclick: () => { tests.filter.set(s.key, key); renderTests(); },
  })));

  for (const g of r.groups || []) {
    const cases = filter === 'failed' ? g.cases.filter((c) => leafCases([c]).some((x) => !x.pass)) : g.cases;
    if (!cases.length) continue;
    const leaves = leafCases(g.cases);
    const ok = leaves.filter((c) => c.pass).length;
    body.append(el('div', { class: 'group' }, [
      el('div', { class: 'group-head' }, [
        el('h3', { text: g.name }),
        el('span', { class: ok === leaves.length ? 'fb-up small' : 'fb-down small', text: `${ok} of ${leaves.length} passed` }),
      ]),
      g.description ? el('p', { class: 'group-desc', text: g.description }) : null,
      el('ul', { class: 'cases' }, cases.map((c) => caseRow(s.key, g.name, c))),
    ]));
  }
  if (!body.children.length) body.append(el('p', { class: 'empty', text: filter === 'failed' ? 'Nothing failed in the last run.' : 'No results.' }));

  return el('section', { class: `card ${r.status === 'failed' || r.status === 'error' ? 'card--key' : ''}` }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: s.label }),
      el('p', { class: 'hint', text: r.finishedAt ? `Last run ${fmtWhen(r.finishedAt)} · ${fmtDur(r.durationMs)}` : '' }),
    ]),
    r.metrics?.length ? el('div', { class: 'metrics' }, r.metrics.map((m) => el('div', { class: 'metric' }, [el('span', { class: 'l', text: m.label }), el('span', { class: 'v', text: m.value })]))) : null,
    r.log ? el('div', {}, [el('p', { class: 'msg err', text: "The tests couldn't finish. Output:" }), el('pre', { class: 'testlog', text: r.log })]) : null,
    r.groups?.length ? seg : null,
    body,
  ]);
}

function caseRow(suite, group, c) {
  const id = `${suite}\u0000${group}\u0000${c.name}`;
  const extra = [];
  if (c.error) extra.push(el('pre', { class: 'testlog', text: c.error }));
  if (c.children?.length) extra.push(el('ul', { class: 'cases cases--sub' }, c.children.map((x) => caseRow(suite, `${group}\u0000${c.name}`, x))));
  if (c.answer) {
    const d = el('details', { class: 'tbl answer' }, [el('summary', { text: 'Sophia’s answer' }), el('div', { class: 'answer-text', text: c.answer })]);
    if (tests.open.has(id)) d.open = true;
    d.addEventListener('toggle', () => { if (d.open) tests.open.add(id); else tests.open.delete(id); });
    extra.push(d);
  }
  return el('li', { class: `case ${c.pass ? '' : 'case--fail'}` }, [
    el('span', { class: `pill ${c.pass ? 'pill--up' : 'pill--down'}`, text: c.pass ? 'Pass' : 'Fail' }),
    el('div', { class: 'case-body' }, [
      el('div', { class: 'case-name', text: c.name }),
      c.detail ? el('div', { class: 'muted small', text: c.detail }) : null,
      ...extra,
    ]),
    c.durationMs != null ? el('span', { class: 'case-dur', text: fmtDur(c.durationMs) }) : null,
  ]);
}

route();
