// Covers: Leaving out content the site admin made just to try things out ("Wisdom-TEST", "test234"), while keeping content that uses "test" for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testMarker, placeholderText, words, testReason, KEEP } from '../src/ingest/test-content.mjs';

test('test pages, lists and files the admin made are caught', () => {
  for (const name of [
    'Wisdom-TEST.aspx', 'mary-test.aspx', 'roadmap-test.aspx', 'DtlTestPage.aspx', 'AbrInsideTEST.aspx',
    'ForProvidersTEST.aspx', 'AbridgeTestq.aspx', 'TESTANALYTICS.aspx', 'test234', 'maryTest', 'BCATESTLOOKUP',
    'TESTBCA', 'Test', 'test folder', 'Shared Documents/Test/Upgrade guide.pdf', 'Copy of handout - test.docx', 'BC Test Logo.png',
  ]) assert.ok(testMarker(name), `${name} should be test content`);
});

test('real uses of "test" are kept', () => {
  for (const name of [
    'Resulting - Add Tests to an Existing Specimen.pdf', 'Rapid Retest.pdf', 'FUNGUS TESTING LABORATORY',
    'Texas-A&M-System-Home-to-Nation’s-Fastest-University-Supercomputer.aspx', 'Abridge - Clinician Testimonials - Long.mp4',
    'Latest news', 'COVID Test Ordering', 'Lab Test Directory', 'Point-of-Care Test Results.pdf', 'Beaker test build',
    'Drug screen test', 'Upgrade guide', 'Contest winners', 'Protest policy',
  ]) assert.equal(testMarker(name), null, `${name} should be kept`);
});

test('names are split into words the way people write them', () => {
  assert.deepEqual(words('AbrInsideTEST.aspx'), ['Abr', 'Inside', 'TEST']);
  assert.deepEqual(words('test234'), ['test', '234']);
  assert.deepEqual(words('maryTest'), ['mary', 'Test']);
});

test('placeholder text is spotted, real text is not', () => {
  assert.ok(placeholderText('test'));
  assert.ok(placeholderText('Testing 123'));
  assert.ok(placeholderText('Lorem ipsum dolor sit amet, consectetur adipiscing elit.'));
  assert.equal(placeholderText('Test results appear in Chart Review after the lab verifies them.'), false);
});

test('regression: "Fastest" is not "test" (the Supercomputer news page was once dropped)', () => {
  assert.equal(testMarker('Texas-A&M-System-Home-to-Nation’s-Fastest-University-Supercomputer.aspx'), null);
  for (const w of ['latest', 'fastest', 'retest', 'contest', 'attest', 'protest', 'testing', 'tested', 'testimonials', 'intestinal']) {
    assert.equal(testMarker(w), null, w);
  }
});

test('testMarker returns the word that gave it away; empty names are not test content', () => {
  assert.equal(testMarker('AbridgeTestq.aspx'), 'Testq');
  assert.equal(testMarker('Wisdom-TEST.aspx'), 'TEST');
  assert.equal(testMarker(''), null);
  assert.equal(testMarker(null), null);
  assert.equal(testMarker(undefined), null);
});

test('"test" next to a real-test word is kept, on its own it is not', () => {
  assert.equal(testMarker('Strep test'), null);
  assert.equal(testMarker('Blood_test_guide'), null, 'underscores and dashes count as spaces');
  assert.equal(testMarker('Guide test'), 'test');
});

test('KEEP holds lower-cased names and overrides the rule', () => {
  for (const n of KEEP) assert.equal(n, n.toLowerCase());
  KEEP.add('my test page.aspx');
  try {
    assert.equal(testMarker('My Test Page.aspx'), null);
  } finally { KEEP.delete('my test page.aspx'); }
});

test('words: extensions, acronyms and letter/digit boundaries', () => {
  assert.deepEqual(words('BCTest.pdf'), ['BC', 'Test']);
  assert.deepEqual(words('v2Guide'), ['v', '2', 'Guide']);
  assert.deepEqual(words('a--b__c'), ['a', 'b', 'c']);
  assert.deepEqual(words(''), []);
});

test('placeholderText: empty and long text are not placeholders', () => {
  assert.equal(placeholderText(''), false);
  assert.equal(placeholderText(null), false);
  assert.ok(placeholderText('This is a test'));
  assert.ok(placeholderText('this is just a test!'));
  assert.equal(placeholderText('test '.repeat(20)), false, '60 characters or more is real text');
});

test('testReason names the first marked name, across arrays', () => {
  assert.equal(testReason('Upgrade guide', ['Shared Documents', 'mary-test']), 'test content: "mary-test"');
  assert.equal(testReason('Upgrade guide', 'Latest news'), null);
  assert.equal(testReason(), null);
});
