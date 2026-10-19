// Covers: Epic upgrade dates from the Upgrade Timeline: every spelling of a version, and turning "the last" or "the next upgrade" into the actual version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionForms, buildFacts } from '../server/facts.mjs';

test('versionForms gives the long, short and two-digit-year spellings, long first', () => {
  const all = ['vFebruary2026', 'vFeb2026', 'vFeb26'];
  for (const v of ['vFeb2026', 'vFebruary2026', 'vFeb26', 'vfeb 2026', 'VFEB.2026']) assert.deepEqual(versionForms(v), all, v);
  assert.deepEqual(versionForms('vSept2025'), ['vSeptember2025', 'vSep2025', 'vSep25']);
  assert.deepEqual(versionForms('vMay2026'), ['vMay2026', 'vMay26'], 'May has one spelling, no duplicates');
});

test('versionForms finds the version inside longer text and returns other text unchanged', () => {
  assert.deepEqual(versionForms('What changed in vNov2025 for nurses?')[0], 'vNovember2025');
  assert.deepEqual(versionForms('no version here'), ['no version here']);
  assert.deepEqual(versionForms('version 2026'), ['version 2026']);
});

const timeline = (title, date) => ({ list: 'Upgrade Timeline', title, meta: { date } });
const chunks = [
  timeline('vMay2026 go-live', '2026-05-16'),
  timeline('vFeb2026', '2026-02-14'),
  timeline('vNov2025', '2025-11-08'),
  timeline('vAug2026', '2026-08-15'),
  { list: 'Upgrade Timeline', title: 'Planning meeting', meta: { date: '2026-03-01' } },       // not a version
  { list: 'News', title: 'vJan2026 rumours', meta: { date: '2026-01-01' } },                  // not the timeline
  { list: 'Upgrade Timeline', title: 'vDec2026', meta: {} },                                  // no date
];
const facts = buildFacts(chunks);
const JUNE = new Date('2026-06-01T17:00:00Z');

test('upgrades come only from dated versions in the Upgrade Timeline, oldest first', () => {
  assert.deepEqual(facts.upgrades.map((u) => u.version), ['vNovember2025', 'vFebruary2026', 'vMay2026', 'vAugust2026']);
});

test('context: last, previous and next upgrade relative to today', () => {
  const c = facts.context(JUNE);
  assert.equal(c.today, '2026-06-01');
  assert.deepEqual([c.last.version, c.previous.version, c.next.version], ['vMay2026', 'vFebruary2026', 'vAugust2026']);
});

test('context: an upgrade going live today counts as the last one', () => {
  assert.equal(facts.context(new Date('2026-05-16T17:00:00Z')).last.version, 'vMay2026');
});

test('context: "today" is San Antonio time, not UTC', () => {
  // 03:00 UTC on May 16 is still May 15 in Central time.
  const c = facts.context(new Date('2026-05-16T03:00:00Z'));
  assert.equal(c.today, '2026-05-15');
  assert.equal(c.last.version, 'vFebruary2026');
});

test('context: before the first or after the last upgrade', () => {
  const early = facts.context(new Date('2025-01-01T17:00:00Z'));
  assert.deepEqual([early.last, early.previous, early.next.version], [null, null, 'vNovember2025']);
  assert.equal(facts.context(new Date('2027-01-01T17:00:00Z')).next, null);
});

test('expand adds the version a relative question means, in every spelling', () => {
  assert.equal(facts.expand('what changed in the last upgrade', JUNE), 'what changed in the last upgrade vMay2026 vMay26');
  assert.match(facts.expand('when is the next upgrade', JUNE), /vAugust2026 vAug2026 vAug26$/);
  assert.match(facts.expand('what was in the previous release', JUNE), /vFebruary2026 vFeb2026 vFeb26$/);
});

test('expand needs the question to be about an upgrade', () => {
  assert.equal(facts.expand('what is the next training class', JUNE), 'what is the next training class');
});

test('expand adds the other spellings of a version named in the question, not the one already there', () => {
  assert.equal(facts.expand('what is new in vFeb2026', JUNE), 'what is new in vFeb2026 vFebruary2026 vFeb26');
});

test('expand leaves unrelated questions unchanged', () => {
  assert.equal(facts.expand('How do I reset my password?', JUNE), 'How do I reset my password?');
});

test('describe lists the schedule for the prompt', () => {
  const d = facts.describe(JUNE);
  assert.match(d, /today is 2026-06-01/);
  assert.match(d, /Most recent upgrade already live: vMay2026 \(also written vMay26\), go-live 2026-05-16/);
  assert.match(d, /The one before it: vFebruary2026/);
  assert.match(d, /Next upgrade: vAugust2026/);
});

test('a corpus without a timeline has no upgrades and expands nothing relative', () => {
  const empty = buildFacts([]);
  assert.deepEqual(empty.upgrades, []);
  assert.equal(empty.expand('the last upgrade', JUNE), 'the last upgrade');
  assert.doesNotMatch(empty.describe(JUNE), /Most recent/);
});
