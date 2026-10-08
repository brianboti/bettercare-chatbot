// Covers: Listing sources newest first, and marking matches much older than the newest one so they go under "Older results".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderByRecency } from '../server/recency.mjs';

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
