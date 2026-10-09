#!/usr/bin/env node
// Model comparison: can cheaper models do Sophia's two Claude jobs as well as
// the current ones?
//
//   node --env-file-if-exists=.env tools/compare-models.mjs
//     --rewrite claude-haiku-4-5    candidate for the search rewrite
//     --answer claude-sonnet-5-5    candidate for answers
//     --n 30                        answers to compare
//     --only rewrite|answer         run one part
//     --fresh                       ignore saved progress and start over
//
// 1. Search rewrite. The current rewrite model and the candidate rewrite
//    every question we have: the retrieval eval set (does search still find
//    the right source?), the scope set (is "unrelated" still detected?), real
//    questions from the database and chat log, and follow-ups that only make
//    sense with the conversation. Compares what search returns and how each
//    question is classified.
// 2. Answers. For a sample of real questions, both answer models get the
//    exact same passages (retrieved once, with the candidate rewrite) and
//    answer. Claude Opus 5.5 judges each pair blind, twice with the order
//    swapped; a model wins a question only if it wins both orders.
//
// Calls the real API (a few dollars). Progress is saved as it goes
// (data/eval/models-progress.json), so a run that stops (credit, network)
// picks up where it left off without paying twice. Writes
// data/eval/models-<date>.json and .md.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT, loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';
import { isBroad, isOutOfScope } from '../server/chat.mjs';
import { llmAvailable, rewriteQuery, streamAnswer, onUsage } from '../server/llm.mjs';
import { buildUserTurn } from '../server/prompt.mjs';
import { SuggestionSplitter } from '../server/followups.mjs';
import { orderByRecency } from '../server/recency.mjs';
import { costOfResponse } from '../server/pricing.mjs';
import { openStore } from '../server/store.mjs';
import { config } from '../server/config.mjs';
import { RETRIEVAL_CASES, SCOPE_CASES } from './eval-cases.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const ONLY = arg('only', null);
const REWRITE = { base: config.REWRITE_MODEL, cand: arg('rewrite', 'claude-haiku-4-5') };
const ANSWER = { base: config.ANTHROPIC_MODEL, cand: arg('answer', 'claude-sonnet-5-5') };
const N = Number(arg('n', 30));
const JUDGE = 'claude-opus-5-5';

// Saved progress, keyed by the models compared so a different pairing starts over.
const PROGRESS = resolve(ROOT, 'data/eval/models-progress.json');
const runKey = JSON.stringify([REWRITE, ANSWER, N]);
let progress = { key: runKey, rewrite: null, answers: {} };
if (!process.argv.includes('--fresh') && existsSync(PROGRESS)) {
  const saved = JSON.parse(readFileSync(PROGRESS, 'utf8'));
  if (saved.key === runKey) { progress = saved; console.log(`resuming: ${progress.rewrite ? 'rewrites done, ' : ''}${Object.keys(progress.answers).length} answers done`); }
}
const saveProgress = () => { mkdirSync(dirname(PROGRESS), { recursive: true }); writeFileSync(PROGRESS, JSON.stringify(progress)); };

// Out of credit or bad key: stop now instead of failing every remaining call.
const fatal = (e) => e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || /credit balance/i.test(e?.message || '');

if (!llmAvailable()) { console.error('Needs ANTHROPIC_API_KEY in .env.'); process.exit(2); }

// Spend per model and job, from every call's usage.
const spend = new Map();
const track = (purpose, model, usage) => {
  const k = `${purpose}\u0000${model}`;
  const s = spend.get(k) || { purpose, model, calls: 0, cost: 0 };
  s.calls++; s.cost += costOfResponse(model, usage).cost || 0;
  spend.set(k, s);
};
onUsage((c) => track(c.purpose, c.model, c.usage));

const retriever = await buildRetriever(loadChunks(), { log: () => {} });
const facts = retriever.facts.describe();
const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/** Run fn over items, `width` at a time, in order. */
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------- questions

// Follow-ups: the rewrite must resolve them against the conversation.
const FOLLOWUPS = [
  ['How do I set up Haiku on my phone?', 'Download Epic Haiku from the App Store or Google Play, then scan the QR code from Epic Hyperspace under Epic button > Personalize > Mobile Device Setup [1].', 'What if I have an Android tablet instead?'],
  ['When is the next Epic upgrade?', 'The next upgrade is vMay2026, going live in May 2026 [1].', 'What changes for nurses in it?'],
  ['What is Abridge?', 'Abridge is the ambient AI documentation tool that listens to the visit and drafts the note in Epic [1].', 'How do I get access to it?'],
  ['Where is the cash drawer tip sheet?', 'It is the "Cash Drawer" tip sheet in the Front Desk tip sheets library [1].', 'Is there one for refunds too?'],
  ['What changed for surgeons in the last upgrade?', 'Surgeons got changes to surgical scheduling and case requests in OpTime [1, 2].', 'Give me the short version.'],
  ['Who do I call for Epic help?', 'Call the Health IT help desk at 210-450-4800 [1].', 'Can I submit a ticket online instead?'],
  ['How do I cover someone else\'s In Basket?', 'Use the "attach to an InBasket" option described in the InBasket Hack tip sheet [1].', 'And how do I stop covering it?'],
  ['What is Epic Thrive training?', 'Thrive is the hands-on training offered before each Epic upgrade [1].', 'When is the next one for physicians?'],
];

function questionSet() {
  const items = [];
  const seen = new Set();
  const add = (it) => { const k = `${it.history.map((m) => m.content).join('|')}|${it.q}`.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(it); } };
  for (const [q, expect] of RETRIEVAL_CASES) add({ q, history: [], source: 'retrieval eval', expect });
  for (const [group, q, opts = {}] of SCOPE_CASES) add({ q, history: [], source: 'scope eval', group, control: !!opts.control });
  for (const [first, answer, q] of FOLLOWUPS) add({ q, history: [{ role: 'user', content: first }, { role: 'assistant', content: answer }], source: 'follow-up' });
  // Real questions people asked: the database and the chat log.
  const store = openStore(config.DB_FILE);
  for (const r of store.db.prepare('SELECT DISTINCT question FROM turns').all()) add({ q: r.question, history: [], source: 'asked' });
  store.close();
  const log = resolve(ROOT, 'data/logs/chat.jsonl');
  if (existsSync(log)) for (const line of readFileSync(log, 'utf8').trim().split('\n')) { try { add({ q: JSON.parse(line).question, history: [], source: 'asked' }); } catch { /* skip */ } }
  return items;
}

// ---------------------------------------------------------------- 1. rewrite

/** What the chat would search for and get back, for one rewrite. */
async function searchFor(it, r) {
  const queries = it.history.length ? [r.query] : [it.q, r.query];
  const broad = r.intent === 'broad' || isBroad(it.q);
  const found = await retriever.retrieve(queries, broad ? { topK: config.BROAD_TOP_K, maxPerSource: config.BROAD_MAX_PER_SOURCE } : {});
  return { ...found, broad };
}

const matches = (c, e) => (e.startsWith('text:') ? c.text.toLowerCase().includes(e.slice(5).toLowerCase()) : `${c.id} ${c.title}`.toLowerCase().includes(e.toLowerCase()));

async function compareRewrites(items) {
  console.log(`\n1. Search rewrite: ${REWRITE.base} vs ${REWRITE.cand} on ${items.length} questions`);
  return pool(items, 4, async (it, i) => {
    const out = { ...it };
    for (const arm of ['base', 'cand']) {
      const t0 = Date.now();
      let r;
      try { r = await rewriteQuery(it.history, it.q, facts, '', { model: REWRITE[arm] }); } catch (e) { if (fatal(e)) throw e; r = { query: it.q, topics: [], intent: null, error: e.message }; }
      const ms = Date.now() - t0;
      const found = await searchFor(it, r);
      out[arm] = {
        ...r, ms, lowConfidence: found.lowConfidence,
        top: found.results.map((c) => c.id),
        rank: it.expect ? found.results.findIndex((c) => it.expect.some((e) => matches(c, e))) : null,
        outOfScope: isOutOfScope(r.intent, found.lowConfidence),
      };
    }
    const a = new Set(out.base.top), b = new Set(out.cand.top);
    out.overlap = a.size + b.size ? [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size : 1;
    if ((i + 1) % 20 === 0) console.log(`   ${i + 1}/${items.length}`);
    return out;
  });
}

function rewriteSummary(rows) {
  const arm = (k) => {
    const ev = rows.filter((r) => r.expect);
    const answerable = ev.filter((r) => r.expect !== null);
    const found = answerable.filter((r) => r[k].rank >= 0);
    const unrelated = rows.filter((r) => r.group === 'Unrelated' || r.group === 'Medical, not on the site');
    const controls = rows.filter((r) => r.control);
    return {
      model: REWRITE[k],
      found: `${found.length}/${answerable.length}`,
      mrr: answerable.reduce((s, r) => s + (r[k].rank >= 0 ? 1 / (r[k].rank + 1) : 0), 0) / answerable.length,
      unrelatedSkipped: `${unrelated.filter((r) => r[k].outOfScope).length}/${unrelated.length}`,
      controlsAnswered: `${controls.filter((r) => !r[k].outOfScope).length}/${controls.length}`,
      errors: rows.filter((r) => r[k].error).length,
      medianMs: [...rows.map((r) => r[k].ms)].sort((x, y) => x - y)[rows.length >> 1],
    };
  };
  const agree = rows.filter((r) => r.base.intent === r.cand.intent).length;
  const sameSkip = rows.filter((r) => r.base.outOfScope === r.cand.outOfScope).length;
  return {
    base: arm('base'), cand: arm('cand'),
    intentAgreement: agree / rows.length,
    sameSkipDecision: `${sameSkip}/${rows.length}`,
    meanOverlap: rows.reduce((s, r) => s + r.overlap, 0) / rows.length,
    followupOverlap: (() => { const f = rows.filter((r) => r.source === 'follow-up'); return f.reduce((s, r) => s + r.overlap, 0) / f.length; })(),
  };
}

// ---------------------------------------------------------------- 2. answers

const DECLINE = /(doesn't|does not|don't|do not) (exist|appear|have)[^.]*\b(BetterCare|documents|site)\b|isn't (in|on) the BetterCare/i;
const CITES = /\[\d+(?:\s*,\s*\d+)*\]/;

async function answerWith(model, messages) {
  let split = new SuggestionSplitter(), text = '';
  const t0 = Date.now();
  try {
    const out = await streamAnswer(messages, {
      onText: (t) => { text += split.push(t); },
      onReset: () => { split = new SuggestionSplitter(); text = ''; },
    }, undefined, { model });
    text = (text + split.finish().text).trim();
    return { text, ms: Date.now() - t0, stopReason: out.stopReason, servedBy: out.model, cost: costOfResponse(out.model, out.usage).cost, outputTokens: out.usage.output_tokens };
  } catch (e) {
    if (fatal(e)) throw e;
    return { text: '', ms: Date.now() - t0, error: e.message };
  }
}

const client = new Anthropic();
const JUDGE_SYSTEM = `You compare two answers from Sophia, an assistant that answers questions about UT Health San Antonio's BetterCare SharePoint site using only the numbered excerpts it was given.

Judge which answer serves the person better, by these rules Sophia must follow, in this order of importance:
1. Grounded: every claim is supported by the excerpts. Anything not in the excerpts (general knowledge, guesses, invented steps, numbers or URLs) is a serious fault. When the excerpts don't answer the question, the right answer says "That information doesn't exist in the BetterCare documents" and may point to related items.
2. Correct citations: claims carry [n] markers pointing to excerpts that actually support them.
3. Answers what was asked, with the most useful information first, using the person's conversation for follow-ups.
4. Length fits the question: one or two sentences for a direct question, just the steps for a how-to, longer only for broad questions. Padding, restating the question, or offers to help further are faults. Asking one short clarifying question is fine when the answer genuinely depends on it.

Ignore style differences that don't affect usefulness. Call it a tie when neither is meaningfully better.`;

const VERDICT = {
  type: 'object',
  properties: {
    issues_1: { type: 'string', description: 'Problems with answer 1, or "none".' },
    issues_2: { type: 'string', description: 'Problems with answer 2, or "none".' },
    better: { type: 'string', enum: ['1', '2', 'tie'] },
    margin: { type: 'string', enum: ['clear', 'slight', 'none'] },
    reason: { type: 'string', description: 'One sentence.' },
  },
  required: ['issues_1', 'issues_2', 'better', 'margin', 'reason'],
  additionalProperties: false,
};

async function judge(item, turn, first, second) {
  const convo = item.history.length ? `<conversation>\n${item.history.map((m) => `${m.role}: ${m.content}`).join('\n')}\n</conversation>\n\n` : '';
  const res = await client.beta.messages.create({
    model: JUDGE,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: VERDICT } },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: `${convo}<what_sophia_was_given>\n${turn}\n</what_sophia_was_given>\n\n<answer_1>\n${first}\n</answer_1>\n\n<answer_2>\n${second}\n</answer_2>` }],
  });
  track('judge', res.model, res.usage);
  if (res.stop_reason !== 'end_turn') return null;
  try { return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')); } catch { return null; }
}

/** Deterministic shuffle, so reruns pick the same sample. */
function sample(list, n) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  return list.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, x]) => x);
}

async function compareAnswers(pool_) {
  console.log(`\n2. Answers: ${ANSWER.base} vs ${ANSWER.cand} on ${pool_.length} questions (judge ${JUDGE})`);
  return pool(pool_, 3, async (it, i) => {
    const key = `${it.history.map((m) => m.content).join('|')}|${it.q}`;
    if (progress.answers[key]) return progress.answers[key];
    // One retrieval for both models (with the candidate rewrite, as it would run).
    const r = it.cand || await rewriteQuery(it.history, it.q, facts, '', { model: REWRITE.cand });
    const found = await searchFor(it, r);
    const { results, older } = orderByRecency(found.results, { windowDays: config.RECENT_WINDOW_DAYS });
    const turn = buildUserTurn(it.q, results, { lowConfidence: found.lowConfidence, today, facts, broad: found.broad, intent: r.intent, older });
    const messages = [...it.history, { role: 'user', content: turn }];
    const [base, cand] = await Promise.all([answerWith(ANSWER.base, messages), answerWith(ANSWER.cand, messages)]);
    for (const a of [base, cand]) { a.cites = CITES.test(a.text); a.declines = DECLINE.test(a.text); }

    // Blind, both orders. A win needs both.
    const [v1, v2] = await Promise.all([judge(it, turn, base.text, cand.text), judge(it, turn, cand.text, base.text)]);
    const pick = (v, baseIs) => (!v ? null : v.better === 'tie' ? 'tie' : v.better === baseIs ? 'base' : 'cand');
    const p1 = pick(v1, '1'), p2 = pick(v2, '2');
    const winner = p1 && p1 === p2 ? p1 : 'tie';
    console.log(`   ${String(i + 1).padStart(2)}. ${winner.padEnd(4)}  ${it.q.slice(0, 70)}`);
    const row = {
      q: it.q, history: it.history, source: it.source, query: r.query, intent: r.intent,
      base, cand, winner, orders: [p1, p2],
      verdicts: [v1, v2],
    };
    progress.answers[key] = row;
    saveProgress();
    return row;
  });
}

function answerSummary(rows) {
  const arm = (k) => {
    const ok = rows.filter((r) => !r[k].error);
    return {
      model: ANSWER[k],
      wins: rows.filter((r) => r.winner === k).length,
      clearWins: rows.filter((r) => r.winner === k && r.verdicts.every((v) => v?.margin === 'clear')).length,
      errors: rows.filter((r) => r[k].error).length,
      refusals: rows.filter((r) => r[k].stopReason === 'refusal').length,
      cited: rows.filter((r) => r[k].cites).length,
      avgCost: ok.reduce((s, r) => s + (r[k].cost || 0), 0) / ok.length,
      avgChars: ok.reduce((s, r) => s + r[k].text.length, 0) / ok.length,
      medianMs: ok.map((r) => r[k].ms).sort((x, y) => x - y)[ok.length >> 1],
    };
  };
  return { base: arm('base'), cand: arm('cand'), ties: rows.filter((r) => r.winner === 'tie').length, n: rows.length };
}

// ---------------------------------------------------------------- run

const items = questionSet();
let rewrite = null, answers = null;
try {
if (ONLY !== 'answer') {
  rewrite = progress.rewrite || await compareRewrites(items);
  progress.rewrite = rewrite;
  saveProgress();
}

if (ONLY !== 'rewrite') {
  // Real, in-scope questions (as the current rewrite classifies them), plus follow-ups.
  const rows = rewrite || items.map((it) => ({ ...it }));
  const real = rows.filter((r) => r.source === 'asked' && !(r.base?.outOfScope || r.cand?.outOfScope));
  const picked = [...sample(real, Math.max(0, N - 5)), ...sample(rows.filter((r) => r.source === 'follow-up'), 5)];
  answers = await compareAnswers(picked);
}
} catch (e) {
  if (!fatal(e)) throw e;
  console.error(`\nStopped: ${e.message}\nProgress is saved; run again to continue.`);
  process.exit(3);
}

const result = {
  at: new Date().toISOString(), rewriteModels: REWRITE, answerModels: ANSWER, judge: JUDGE,
  rewrite: rewrite && { summary: rewriteSummary(rewrite), rows: rewrite },
  answers: answers && { summary: answerSummary(answers), rows: answers },
  spend: [...spend.values()],
};

const dir = resolve(ROOT, 'data/eval');
mkdirSync(dir, { recursive: true });
const day = result.at.slice(0, 10);
writeFileSync(resolve(dir, `models-${day}.json`), JSON.stringify(result, null, 1));

// ---------------------------------------------------------------- report

const usd = (v) => `$${v.toFixed(4)}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const md = ['# Sophia model comparison', '', `${result.at.slice(0, 16).replace('T', ' ')} · judge \`${JUDGE}\``, ''];
if (rewrite) {
  const s = result.rewrite.summary;
  md.push('## Search rewrite', '',
    '| | Current | Candidate |', '|---|---|---|',
    `| Model | \`${s.base.model}\` | \`${s.cand.model}\` |`,
    `| Retrieval eval: right source found | ${s.base.found} | ${s.cand.found} |`,
    `| Retrieval eval: MRR | ${s.base.mrr.toFixed(3)} | ${s.cand.mrr.toFixed(3)} |`,
    `| Unrelated/medical questions skipped | ${s.base.unrelatedSkipped} | ${s.cand.unrelatedSkipped} |`,
    `| In-scope controls answered | ${s.base.controlsAnswered} | ${s.cand.controlsAnswered} |`,
    `| Errors | ${s.base.errors} | ${s.cand.errors} |`,
    `| Median latency | ${s.base.medianMs} ms | ${s.cand.medianMs} ms |`,
    '',
    `Same intent: ${(s.intentAgreement * 100).toFixed(0)}% · same skip decision: ${s.sameSkipDecision} · search results overlap: ${(s.meanOverlap * 100).toFixed(0)}% on average, ${(s.followupOverlap * 100).toFixed(0)}% on follow-ups.`, '',
    '### Where they differ', '', '| Question | Current query (intent) | Candidate query (intent) | Overlap |', '|---|---|---|---|',
    ...rewrite.filter((r) => r.overlap < 0.6 || r.base.outOfScope !== r.cand.outOfScope || (r.expect && (r.base.rank >= 0) !== (r.cand.rank >= 0)))
      .map((r) => `| ${cell((r.history.length ? '(follow-up) ' : '') + r.q)} | ${cell(r.base.query)} (${r.base.intent}) | ${cell(r.cand.query)} (${r.cand.intent}) | ${(r.overlap * 100).toFixed(0)}% |`),
    '');
}
if (answers) {
  const s = result.answers.summary;
  md.push('## Answers', '',
    '| | Current | Candidate |', '|---|---|---|',
    `| Model | \`${s.base.model}\` | \`${s.cand.model}\` |`,
    `| Judged better (both orders) | ${s.base.wins} (${s.base.clearWins} clearly) | ${s.cand.wins} (${s.cand.clearWins} clearly) |`,
    `| Ties or split verdicts | ${s.ties} | |`,
    `| Answers with citations | ${s.base.cited}/${s.n} | ${s.cand.cited}/${s.n} |`,
    `| Refusals / errors | ${s.base.refusals} / ${s.base.errors} | ${s.cand.refusals} / ${s.cand.errors} |`,
    `| Average cost | ${usd(s.base.avgCost)} | ${usd(s.cand.avgCost)} |`,
    `| Average length | ${Math.round(s.base.avgChars)} chars | ${Math.round(s.cand.avgChars)} chars |`,
    `| Median time to finish | ${s.base.medianMs} ms | ${s.cand.medianMs} ms |`,
    '', '### Every question', '');
  for (const r of answers) {
    md.push(`#### ${r.history.length ? `(follow-up to "${r.history[0].content}") ` : ''}${r.q}`, '',
      `Winner: **${r.winner === 'base' ? s.base.model : r.winner === 'cand' ? s.cand.model : 'tie'}** · ${r.verdicts.map((v) => v?.reason).filter(Boolean).join(' / ')}`, '',
      `**${s.base.model}:** ${r.base.text || r.base.error}`, '', `**${s.cand.model}:** ${r.cand.text || r.cand.error}`, '');
  }
}
md.push('## Spend for this run', '', '| Job | Model | Calls | Cost |', '|---|---|---|---|',
  ...result.spend.map((x) => `| ${x.purpose} | \`${x.model}\` | ${x.calls} | ${usd(x.cost)} |`),
  `| | | **Total** | **${usd(result.spend.reduce((a, x) => a + x.cost, 0))}** |`, '');
const file = resolve(dir, `models-${day}.md`);
writeFileSync(file, md.join('\n'));
console.log(`\nreport: ${file}`);
if (rewrite) console.log(JSON.stringify(result.rewrite.summary, null, 1));
if (answers) console.log(JSON.stringify(result.answers.summary, null, 1));
console.log(`spend: ${usd(result.spend.reduce((a, x) => a + x.cost, 0))}`);
