// Covers: Listing sources newest first, and marking matches much older than the newest one so they go under "Older results".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderByRecency, sourceDate } from '../server/recency.mjs';

const src = (id, meta = {}) => ({ id, meta });
const ids = (r) => r.results.map((c) => c.id);

test('newest first, then undated, then older ones', () => {
  const r = orderByRecency([
    src('old', { modified: '2024-03-01' }),
    src('contacts'),
    src('mid', { published: '2026-02-10' }),
    src('new', { date: '2026-09-01' }),
  ], { windowDays: 365, today: '2026-10-08' });
  assert.deepEqual(ids(r), ['new', 'mid', 'contacts', 'old']);
  assert.deepEqual([...r.older], ['old']);
  assert.equal(r.cutoff, '2025-09-01');
});

test('the window is measured from the newest match, not from today', () => {
  const r = orderByRecency([src('a', { modified: '2025-01-10' }), src('b', { modified: '2024-02-01' })], { windowDays: 180, today: '2026-10-08' });
  assert.deepEqual(ids(r), ['a', 'b']);
  assert.deepEqual([...r.older], ['b']);
});

test('a future event does not push this year\'s content into "older"', () => {
  const r = orderByRecency([src('event', { date: '2027-04-01' }), src('guide', { modified: '2026-03-01' })], { windowDays: 365, today: '2026-10-08' });
  assert.deepEqual(ids(r), ['event', 'guide']);
  assert.equal(r.older.size, 0);
});

test('nothing dated: order and flags unchanged', () => {
  const r = orderByRecency([src('x'), src('y')], { windowDays: 365 });
  assert.deepEqual(ids(r), ['x', 'y']);
  assert.equal(r.older.size, 0);
});

test('sourceDate prefers the event date, then publish date, then last modified', () => {
  assert.equal(sourceDate(src('a', { date: '2026-01-01', published: '2025-01-01', modified: '2024-01-01' })), '2026-01-01');
  assert.equal(sourceDate(src('a', { published: '2025-01-01', modified: '2024-01-01' })), '2025-01-01');
  assert.equal(sourceDate(src('a', { modified: '2024-01-01' })), '2024-01-01');
  assert.equal(sourceDate(src('a')), null);
  assert.equal(sourceDate({ id: 'no-meta' }), null);
});

test('a source exactly at the cutoff still counts as recent', () => {
  const r = orderByRecency([src('new', { date: '2026-01-11' }), src('edge', { date: '2026-01-01' }), src('old', { date: '2025-12-31' })], { windowDays: 10, today: '2026-06-01' });
  assert.equal(r.cutoff, '2026-01-01');
  assert.deepEqual([...r.older], ['old']);
});

test('the input list is not reordered in place', () => {
  const input = [src('b', { date: '2025-01-01' }), src('a', { date: '2026-01-01' })];
  orderByRecency(input, { windowDays: 365, today: '2026-06-01' });
  assert.deepEqual(input.map((c) => c.id), ['b', 'a']);
});

test('an empty list is fine', () => {
  assert.deepEqual(orderByRecency([], { windowDays: 30 }), { results: [], older: new Set(), cutoff: null });
});
