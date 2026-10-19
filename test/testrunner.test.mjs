// Covers: The admin panel's Tests tab: the list of test suites, finding test files and their descriptions, and turning raw test results into the grouped pass/fail view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUITES, testStatus, startRun, testFiles, fileDescription, unitGroups, countCases } from '../server/testrunner.mjs';
import { ROOT } from '../server/corpus.mjs';

test('every suite has a key, a label, a plain description, a cost and a command', () => {
  const keys = SUITES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const k of ['unit', 'retrieval', 'scope', 'answers']) assert.ok(keys.includes(k), k);
  for (const s of SUITES) {
    assert.ok(s.label && s.description && s.cost, s.key);
    assert.equal(typeof s.args, 'function');
  }
});

test('the unit suite runs every test file in test/ through the JSON reporter', () => {
  const unit = SUITES.find((s) => s.key === 'unit');
  const files = unit.files ? unit.files() : undefined;
  const args = unit.args(files);
  assert.ok(args.includes('--test'));
  assert.ok(args.includes('--test-reporter=./tools/test-reporter-json.mjs'));
  const onDisk = readdirSync(resolve(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs'));
  for (const f of onDisk) assert.ok(args.includes(`test/${f}`), f);
});

test('test files are found by folder, sorted, as paths from the project root', () => {
  const files = testFiles('test');
  assert.ok(files.includes('test/testrunner.test.mjs'));
  assert.deepEqual([...files].sort(), files);
  assert.deepEqual(testFiles('no-such-folder'), []);
});

test('every unit test file starts with a "// Covers:" line, shown in the Tests tab', () => {
  for (const f of testFiles('test')) {
    assert.match(readFileSync(resolve(ROOT, f), 'utf8').split('\n', 1)[0], /^\/\/ Covers: \S/, f);
    assert.ok(fileDescription(f).length > 10, f);
  }
  assert.match(fileDescription('test/store.test.mjs'), /^The database/);
  assert.equal(fileDescription('test/missing.test.mjs'), '');
  assert.equal(fileDescription('package.json'), '', 'a file without the line has no description');
});

test('raw results are grouped by file, with subtests nested under their test', () => {
  const file = resolve(ROOT, 'test/store.test.mjs');
  const groups = unitGroups([
    { name: 'sub a', file, nesting: 1, pass: true, durationMs: 1, error: null },
    { name: 'sub b', file, nesting: 1, pass: false, durationMs: 1, error: 'boom' },
    { name: 'parent', file, nesting: 0, pass: false, durationMs: 3, error: 'a subtest failed' },
    { name: 'plain', file, nesting: 0, pass: true, durationMs: 2, error: null },
    { name: 'loose', file: null, nesting: 0, pass: true, durationMs: 0, error: null },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ['store.test.mjs', 'other']);
  assert.match(groups[0].description, /^The database/);
  const [parent, plain] = groups[0].cases;
  assert.deepEqual(parent.children.map((c) => [c.name, c.pass, c.error]), [['sub a', true, null], ['sub b', false, 'boom']]);
  assert.equal(plain.children, undefined);
  assert.deepEqual(countCases(groups), { passed: 3, failed: 1, total: 4 }, 'a test with subtests counts as its subtests');
});

test('status lists every suite; an unknown suite cannot be started', () => {
  const st = testStatus();
  assert.deepEqual(st.map((s) => s.key), SUITES.map((s) => s.key));
  for (const s of st) assert.ok('run' in s);
  assert.deepEqual(startRun('rm -rf /'), { error: 'unknown suite' });
});
