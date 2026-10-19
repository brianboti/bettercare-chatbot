// Covers: Topic tagging for insights and personalization, and building the question sent to the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagTopics, cleanTopics, roleLabel, ROLES, TOPICS, TOPIC_NAMES } from '../server/topics.mjs';
import { buildUserTurn } from '../server/prompt.mjs';

test('keyword topics', () => {
  assert.deepEqual(tagTopics('How do I get access to Abridge?'), ['Abridge']);
  assert.deepEqual(tagTopics('How do I set up Haiku on my phone?'), ['Haiku & Canto']);
  assert.ok(!tagTopics('Phone number for the lab draw station').includes('Haiku & Canto'));
  // Help-desk is kept only when nothing more specific matched.
  assert.deepEqual(tagTopics('Who do I call for help?'), ['Access & help desk']);
  assert.ok(!tagTopics('Abridge is not working').includes('Access & help desk'));
});

test('model topics are limited to the controlled list', () => {
  assert.deepEqual(cleanTopics(['Abridge', 'Made up', 'Abridge', 'Training']), ['Abridge', 'Training']);
});

test('the user turn carries the person and an intent hint', () => {
  const turn = buildUserTurn('What is the help desk number?', [], { today: 'Monday', person: 'Role: Nurse', intent: 'direct' });
  assert.match(turn, /<person>\nRole: Nurse\n<\/person>/);
  assert.match(turn, /one or two sentences/);
  assert.match(turn, /Question: What is the help desk number\?$/);
});
test('tagTopics returns at most the requested number, most specific first', () => {
  const q = 'Abridge training for surgery in the next upgrade';
  assert.equal(tagTopics(q).length, 2);
  assert.equal(tagTopics(q, 1).length, 1);
  assert.ok(tagTopics(q, 5).length >= 4);
  assert.deepEqual(tagTopics(''), []);
  assert.deepEqual(tagTopics('lorem ipsum'), []);
});

test('tagTopics recognises Epic version names as upgrade questions', () => {
  assert.deepEqual(tagTopics('What changed in vFeb2026?'), ['Epic upgrades']);
  assert.deepEqual(tagTopics('notes for vNovember25'), ['Epic upgrades']);
});

test('cleanTopics tolerates missing input and keeps at most three', () => {
  assert.deepEqual(cleanTopics(undefined), []);
  assert.deepEqual(cleanTopics(null), []);
  assert.equal(cleanTopics(TOPIC_NAMES).length, 3);
});

test('the topic list and its names agree', () => {
  assert.deepEqual(TOPIC_NAMES, Object.keys(TOPICS));
  for (const t of TOPIC_NAMES) assert.ok(TOPICS[t] instanceof RegExp, t);
});

test('every role has a label and only known topics', () => {
  for (const [key, r] of Object.entries(ROLES)) {
    assert.ok(r.label, key);
    assert.ok(r.topics.length, key);
    for (const t of r.topics) assert.ok(TOPIC_NAMES.includes(t), `${key}: ${t}`);
  }
});

test('roleLabel names a role, and is null for an unknown or missing one', () => {
  assert.equal(roleLabel('nurse'), 'Nurse');
  assert.equal(roleLabel('frontdesk'), 'Front desk & scheduling');
  assert.equal(roleLabel('astronaut'), null);
  assert.equal(roleLabel(undefined), null);
});
