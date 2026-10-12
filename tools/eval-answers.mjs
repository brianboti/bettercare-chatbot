#!/usr/bin/env node
// Answer-shape eval: the product owner's rules for every answer.
//
//   npm run eval:answers              all cases (calls the real model, ~1 min, about 40¢)
//   npm run eval:answers -- --verbose print every answer
//
// Each case is a short conversation asked by a demo person with a profile
// role. Every answer must:
//   - open with what Sophia assumed (the "Assuming" line)
//   - cite every bullet and step (counted before the server repairs any)
//   - end by pointing to human help (the Health IT Help Desk)
// and some cases check more: a role said in the conversation beats the
// profile role, the specific guide is cited over general training, and
// "immediate help" gets the help desk number.
//
// Writes a Markdown report to data/eval/answers-<date>.md. Exits 1 on any failure.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';
import { runChat } from '../server/chat.mjs';
import { openStore } from '../server/store.mjs';
import { llmAvailable } from '../server/llm.mjs';
import { PROMPT_VERSION } from '../server/prompt.mjs';
import { config } from '../server/config.mjs';
import { uncitedItems } from '../server/citations.mjs';
import { ANSWER_CASES as CASES } from './eval-cases.mjs';

if (!llmAvailable()) {
  console.error('No model credentials: this eval needs the real model (set ANTHROPIC_API_KEY in .env).');
  process.exit(2);
}

const verbose = process.argv.includes('--verbose');
const retriever = await buildRetriever(loadChunks(), { log: () => {} });
const store = openStore(':memory:');

/** One turn; returns the streamed text, the final text and the events. */
async function ask(user, messages) {
  const r = { streamed: '', answer: null, assumptions: [], sources: [], done: null, error: null };
  const send = (event, data) => {
    if (event === 'token') r.streamed += data.text;
    else if (event === 'reset') { r.streamed = ''; r.assumptions = []; }
    else if (event === 'answer') r.answer = data.text;
    else if (event === 'assumptions') r.assumptions = data;
    else if (event === 'sources') r.sources = data;
    else if (event === 'done') r.done = data;
    else if (event === 'error') r.error = data;
  };
  await runChat({ retriever, store }, messages, send, new AbortController().signal, { user, conversationId: `eval-${user.id}` });
  r.answer ??= r.streamed;
  r.answer = r.answer.trim();
  return r;
}

const cited = (answer, sources) => new Set([...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
  .flatMap((m) => m[1].split(',').map((x) => sources[Number(x) - 1]?.title).filter(Boolean)));

/** [check name, pass, detail] for one turn. */
function grade(c, r) {
  if (r.error) return [['Answered', false, r.error.code]];
  const checks = [
    ['Assuming line', r.assumptions.length > 0, r.assumptions.map((a) => a.text).join(' · ') || 'none'],
    ['Every bullet cited by the model', !uncitedItems(r.streamed).length, uncitedItems(r.streamed).length ? `${uncitedItems(r.streamed).length} bare: ${uncitedItems(r.streamed)[0].slice(0, 60)}…` : 'all cited'],
    ['Every bullet cited as shown', !uncitedItems(r.answer).length, uncitedItems(r.answer).length ? `${uncitedItems(r.answer).length} still bare` : 'all cited'],
    ['Points to human help', /450[-.\s]?4800|450[-.\s]?HELP/i.test(r.answer), ''],
  ];
  const titles = cited(r.answer, r.sources);
  if (c.cites) checks.push(['Cites the specific guide', [...titles].some((t) => c.cites.test(t)), [...titles].join('; ').slice(0, 120)]);
  if (c.mentions) checks.push(['Answer content', c.mentions.test(r.streamed), '']);
  if (c.assumes) checks.push(['Uses what they said', c.assumes.test(r.assumptions.map((a) => a.text).join(' ') + ' ' + r.answer), r.assumptions.map((a) => a.text).join(' · ')]);
  if (c.notRole) checks.push(['Not the profile role', !c.notRole.test(r.assumptions.map((a) => a.text).join(' ') + ' ' + r.answer), '']);
  return checks;
}

const results = [];
await Promise.all(CASES.map(async (c, ci) => {
  const user = store.saveUser(`eval-${ci}`, { name: 'Eval Person', role: c.role, department: c.department || null });
  const messages = [];
  for (const [ti, turn] of c.turns.entries()) {
    messages.push({ role: 'user', content: turn.q });
    const r = await ask(user, [...messages]);
    const asAssistant = r.assumptions.length ? `(Assumed: ${r.assumptions.map((a) => a.text).join('; ')})\n\n${r.answer}` : r.answer;
    messages.push({ role: 'assistant', content: asAssistant });
    const checks = grade(turn, r);
    results.push({ case: c.name, turn: ti + 1, question: turn.q, checks, answer: r.answer, assumptions: r.assumptions });
  }
}));
results.sort((a, b) => a.case.localeCompare(b.case) || a.turn - b.turn);

for (const r of results) {
  const ok = r.checks.every(([, p]) => p);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.case} #${r.turn}: ${r.question}`);
  for (const [name, pass, detail] of r.checks) if (!pass || verbose) console.log(`      ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (verbose || !ok) console.log(`      > ${r.answer.replace(/\n+/g, ' ⏎ ').slice(0, 700)}`);
}

const all = results.flatMap((r) => r.checks);
const passed = all.filter(([, p]) => p).length;
const turnsOk = results.filter((r) => r.checks.every(([, p]) => p)).length;
const names = [...new Set(all.map(([n]) => n))];
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const md = [
  '# Sophia answer-shape test',
  '',
  `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · model \`${config.ANTHROPIC_MODEL}\` · rewrite \`${config.REWRITE_MODEL}\` · prompt \`${PROMPT_VERSION}\``,
  '',
  `**${turnsOk} of ${results.length} answers passed every check** (${passed} of ${all.length} checks).`,
  '',
  '| Check | Passed |', '|---|---|',
  ...names.map((n) => { const cs = all.filter(([x]) => x === n); return `| ${n} | ${cs.filter(([, p]) => p).length} / ${cs.length} |`; }),
  '',
  '| Case | Question | Failed checks | Assuming | Answer |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.case} #${r.turn} | ${cell(r.question)} | ${r.checks.filter(([, p]) => !p).map(([n, , d]) => `${n}${d ? ` (${d})` : ''}`).join('; ') || '—'} | ${cell(r.assumptions.map((a) => a.text).join(' · '))} | ${cell(r.answer).slice(0, 400)} |`),
  '',
].join('\n');
const dir = resolve(ROOT, 'data/eval');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `answers-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, md);
console.log(`\n${turnsOk}/${results.length} answers passed every check (${passed}/${all.length} checks)   report: ${file}`);
if (turnsOk < results.length) process.exitCode = 1;

if (process.argv.includes('--json')) {
  console.log(`@@RESULT ${JSON.stringify({
    metrics: [
      { label: 'Answers passing every check', value: `${turnsOk} of ${results.length}` },
      { label: 'Checks passed', value: `${passed} of ${all.length}` },
      { label: 'Model', value: config.ANTHROPIC_MODEL },
      { label: 'Prompt version', value: PROMPT_VERSION },
    ],
    groups: [...new Set(results.map((r) => r.case))].map((name) => ({
      name, description: '',
      cases: results.filter((r) => r.case === name).map((r) => ({
        name: r.question, pass: r.checks.every(([, p]) => p),
        detail: r.checks.filter(([, p]) => !p).map(([n]) => n).join(', ') || 'all checks passed', answer: r.answer,
      })),
    })),
  })}`);
}
