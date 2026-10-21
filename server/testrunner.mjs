// Runs the project's test suites for the admin panel's Tests tab.
//
// Each suite is a fixed command run as a child process (nothing from the
// request reaches the command line). One run per suite at a time; the last
// result of each suite is kept in TEST_RESULTS_DIR (data/eval)/last-<suite>.json so it survives
// a restart.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { ROOT } from './corpus.mjs';
import { config } from './config.mjs';

const OUT_DIR = config.TEST_RESULTS_DIR;
const TIMEOUT_MS = 10 * 60_000;

export const SUITES = [
  {
    key: 'unit',
    label: 'Unit tests',
    description: 'Checks each part of the server on its own: the database, suggestion chips, topic tagging, and the off-topic rule. No network, no AI model.',
    cost: 'Free · a few seconds',
    files: () => testFiles('test'),
    args: (files) => ['--test', '--test-reporter=./tools/test-reporter-json.mjs', ...files],
  },
  {
    key: 'integration',
    label: 'API checks',
    description: "Starts a private copy of the server and calls it the way the site and extension do: asking, history, feedback, and who may see what. No AI model.",
    cost: 'Free · a few seconds',
    files: () => testFiles('test/integration'),
    args: (files) => ['--test', '--test-reporter=./tools/test-reporter-json.mjs', ...files],
  },
  {
    key: 'e2e',
    label: 'End-to-end',
    description: 'Drives the BetterCare site in a real (hidden) browser like a person would: the introduction, asking and rating, history, and the admin panel. No AI model.',
    cost: 'Free · about a minute',
    files: () => testFiles('test/e2e'),
    args: (files) => ['--test', '--test-concurrency=1', '--test-reporter=./tools/test-reporter-json.mjs', ...files],
  },
  {
    key: 'retrieval',
    label: 'Search accuracy',
    description: 'Asks 35 fixed questions of the search engine and checks the right BetterCare page or file comes back, and that unrelated questions are flagged.',
    cost: 'Free · a few seconds',
    args: () => ['tools/eval-retrieval.mjs', '--json'],
  },
  {
    key: 'scope',
    label: 'Stays on topic',
    description: 'Asks Sophia 24 questions with the real AI model: unrelated, medical, and trick questions must be declined, and real BetterCare questions must still be answered.',
    cost: 'Calls Claude · about 1 minute',
    args: () => ['tools/eval-scope.mjs', '--json'],
  },
  {
    key: 'answers',
    label: 'Answer rules',
    description: 'Six questions with the real AI model, including a three-question follow-up conversation: every answer must say what it assumed, cite every bullet, and point to the help desk.',
    cost: 'Calls Claude · about 1 minute',
    args: () => ['tools/eval-answers.mjs', '--json'],
  },
];

const runs = new Map(); // key -> run

/** The *.test.mjs files directly in a folder, as paths from the project root. */
export function testFiles(dir) {
  try {
    return readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${dir}/${f}`);
  } catch { return []; }
}

/** The "// Covers: …" first line of a test file (a path from the project root). */
export function fileDescription(file) {
  try {
    const first = readFileSync(resolve(ROOT, file), 'utf8').split('\n', 1)[0];
    return first.startsWith('// Covers:') ? first.slice(10).trim() : '';
  } catch { return ''; }
}

const lastFile = (key) => resolve(OUT_DIR, `last-${key}.json`);

function loadLast(key) {
  if (runs.has(key)) return runs.get(key);
  try {
    if (existsSync(lastFile(key))) {
      const r = JSON.parse(readFileSync(lastFile(key), 'utf8'));
      runs.set(key, r);
      return r;
    }
  } catch { /* unreadable: treat as never run */ }
  return null;
}

/** Nest node:test results: a test's subtests are reported just before it, one level deeper. */
export function unitGroups(lines) {
  const byFile = new Map();
  for (const t of lines) {
    const f = t.file ? relative(ROOT, t.file) : 'other';
    const list = byFile.get(f) || byFile.set(f, []).get(f);
    const children = [];
    while (list.length && list[list.length - 1].nesting > t.nesting) children.unshift(list.pop());
    list.push({ ...t, children });
  }
  const toCase = (t) => ({
    name: t.name, pass: t.pass, durationMs: t.durationMs, error: t.error,
    children: t.children.length ? t.children.map(toCase) : undefined,
  });
  return [...byFile.entries()].map(([file, list]) => ({
    name: basename(file), description: fileDescription(file), cases: list.map(toCase),
  }));
}

export function countCases(groups) {
  let passed = 0, failed = 0;
  const walk = (c) => { if (c.children?.length) c.children.forEach(walk); else if (c.pass) passed++; else failed++; };
  groups.forEach((g) => g.cases.forEach(walk));
  return { passed, failed, total: passed + failed };
}

export function testStatus() {
  return SUITES.map((s) => ({ key: s.key, label: s.label, description: s.description, cost: s.cost, run: loadLast(s.key) }));
}

export function startRun(key) {
  const suite = SUITES.find((s) => s.key === key);
  if (!suite) return { error: 'unknown suite' };
  if (runs.get(key)?.status === 'running') return { run: runs.get(key) };
  // node --test with no files would run every test it can find.
  const files = suite.files?.();
  if (files && !files.length) return { error: `no test files for ${suite.label}` };

  const run = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, progress: { done: 0 }, summary: null, metrics: [], groups: [], log: '' };
  runs.set(key, run);

  // BACKUP_DISABLED: an eval measures the configured Claude models, never a silent switch to the backup.
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', ...suite.args(files)], { cwd: ROOT, env: { ...process.env, BACKUP_DISABLED: '1' } });
  const unitLines = [];
  let out = '', err = '', result = null;
  const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);

  const onLine = (line) => {
    if (suite.files) {
      try { unitLines.push(JSON.parse(line)); run.progress.done = unitLines.length; } catch { /* not ours */ }
    } else if (line.startsWith('@@RESULT ')) {
      try { result = JSON.parse(line.slice(9)); } catch { /* malformed */ }
    } else if (/^(PASS|FAIL)\b/.test(line)) {
      run.progress.done++;
    }
  };
  child.stdout.on('data', (b) => {
    out += b;
    const lines = out.split('\n');
    out = lines.pop();
    lines.forEach(onLine);
  });
  child.stderr.on('data', (b) => { err = (err + b).slice(-8000); });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (out) onLine(out);
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (suite.files) run.groups = unitGroups(unitLines);
    else if (result) { run.groups = result.groups; run.metrics = result.metrics || []; }
    run.summary = countCases(run.groups);
    const crashed = !run.summary.total || (code !== 0 && !run.summary.failed);
    run.status = crashed ? 'error' : run.summary.failed ? 'failed' : 'passed';
    if (crashed) run.log = err.trim() || `The test command exited with code ${code}.`;
    delete run.progress;
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(lastFile(key), JSON.stringify(run));
    } catch { /* keeping it in memory is enough */ }
  });
  child.on('error', (e) => { run.log = e.message; });

  return { run };
}
