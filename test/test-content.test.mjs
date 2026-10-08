// Covers: Leaving out content the site admin made just to try things out ("Wisdom-TEST", "test234"), while keeping content that uses "test" for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testMarker, placeholderText, words } from '../src/ingest/test-content.mjs';

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
