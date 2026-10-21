// Covers: The extension's SharePoint sign-in helper (extension/lib/sharepoint.js): reading who is signed in from SharePoint's currentuser answer, and when a saved answer is too old to use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spIdentity, freshSaved, fetchSharePointUser, CURRENT_USER, MAX_AGE_MS } from '../extension/lib/sharepoint.js';

test('spIdentity: the email and display name, lowercased email', () => {
  assert.deepEqual(spIdentity({ Email: 'Jane.Doe@UTHSCSA.edu', Title: 'Doe, Jane', LoginName: 'i:0#.f|membership|jane.doe@uthscsa.edu' }), { email: 'jane.doe@uthscsa.edu', name: 'Doe, Jane' });
});

test('spIdentity: no Email field falls back to the UPN, then to the claims login name', () => {
  assert.equal(spIdentity({ Email: '', UserPrincipalName: 'pat@uthscsa.edu' }).email, 'pat@uthscsa.edu');
  assert.deepEqual(spIdentity({ LoginName: 'i:0#.f|membership|sam.n@uthscsa.edu' }), { email: 'sam.n@uthscsa.edu', name: null });
});

test('spIdentity: nothing that looks like an email means no identity', () => {
  assert.equal(spIdentity({ Title: 'Guest', LoginName: 'i:0#.w|domain\\guest' }), null);
  assert.equal(spIdentity(null), null);
  assert.equal(spIdentity('text'), null);
});

test('freshSaved: what launcher.js saved, while it is under 12 hours old', () => {
  const user = { Email: 'jane@uthscsa.edu', Title: 'Jane' };
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.deepEqual(freshSaved({ at: now - 60_000, user }, now), { email: 'jane@uthscsa.edu', name: 'Jane' });
  assert.equal(freshSaved({ at: now - MAX_AGE_MS - 1, user }, now), null);
  assert.equal(freshSaved(undefined, now), null);
});

test('fetchSharePointUser: one read-only GET with the browser\'s SharePoint sign-in; null when not signed in', async () => {
  const calls = [];
  const ok = async (url, opts) => { calls.push([url, opts]); return { ok: true, json: async () => ({ Email: 'jane@uthscsa.edu', Title: 'Jane' }) }; };
  assert.deepEqual(await fetchSharePointUser(ok), { email: 'jane@uthscsa.edu', name: 'Jane' });
  assert.equal(calls[0][0], CURRENT_USER);
  assert.equal(calls[0][1].credentials, 'include');
  assert.equal(calls[0][1].method, undefined, 'a GET');
  assert.equal(await fetchSharePointUser(async () => ({ ok: false, status: 403 })), null);
  assert.equal(await fetchSharePointUser(async () => { throw new TypeError('offline'); }), null);
});
