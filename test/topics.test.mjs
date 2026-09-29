import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagTopics, cleanTopics } from '../server/topics.mjs';
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
