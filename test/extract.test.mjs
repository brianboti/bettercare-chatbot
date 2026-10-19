// Covers: Turning SharePoint list rows into search passages: per-list rules, lookups, hidden and placeholder rows, and duplicate Q&As copied between lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../src/extract.mjs';
import { LISTS } from '../src/lists.config.mjs';

const faqRow = (Id, Title, Answers, CategoryId = 1) => ({ Id, Title, Answers, CategoryId });

test('lists config: every list is exactly one of build / sameAs / lookup / skip', () => {
  for (const [name, rule] of Object.entries(LISTS)) {
    const kinds = [typeof rule.build === 'function', !!rule.sameAs, rule.lookup === true, typeof rule.skip === 'string'].filter(Boolean);
    assert.equal(kinds.length, 1, `${name} has ${kinds.length} modes`);
    if (rule.sameAs) assert.ok(LISTS[rule.sameAs]?.build, `${name}.sameAs points at a list with build()`);
    if (rule.categoryList) assert.equal(LISTS[rule.categoryList]?.lookup, true, `${name}'s category list is a lookup`);
    if (rule.published) assert.equal(typeof rule.published, 'function');
  }
});

test('FAQ rows: title + answer text, links, and the category from the lookup list', () => {
  const { chunks, stats } = extract([
    { list: 'FAQCategories', id: 'cat', items: [{ Id: 1, Title: 'Login' }] },
    { list: 'FAQQuestions', id: 'guid-1', items: [faqRow(7, 'How do I reset my password?', '<p>Call the <a href="https://help.org">help desk</a>.</p>')] },
  ]);
  assert.equal(chunks.length, 1);
  const c = chunks[0];
  assert.equal(c.id, 'FAQQuestions:7');
  assert.equal(c.kind, 'faq');
  assert.equal(c.title, 'How do I reset my password?');
  assert.equal(c.text, 'How do I reset my password?\n\nCall the help desk.');
  assert.deepEqual(c.links, [{ text: 'help desk', url: 'https://help.org' }]);
  assert.deepEqual(c.meta, { category: 'Login' });
  assert.match(c.url, /ListId=\{guid-1\}&ID=7$/);
  assert.match(c.hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(stats.lists, [{ list: 'FAQQuestions', kind: 'faq', rows: 1, chunks: 1 }]);
});

test('lookup ids given as [1] resolve too; a missing lookup leaves no category', () => {
  const { chunks } = extract([
    { list: 'FAQCategories', id: 'cat', items: [{ ID: 2, Title: 'Billing' }] },
    { list: 'FAQQuestions', id: 'g', items: [faqRow(1, 'Q one here?', 'Answer one.', [2]), faqRow(2, 'Q two here?', 'Answer two.', 99)] },
  ]);
  assert.equal(chunks[0].meta.category, 'Billing');
  assert.equal(chunks[1].meta, undefined, 'empty metadata is pruned away');
});

test('unmapped, skipped and lookup lists produce no chunks and are reported', () => {
  const { chunks, stats } = extract([
    { list: 'SomethingNew', id: 'x', items: [{ Id: 1, Title: 'a' }] },
    { list: 'HOPD', id: 'y', items: [{ Id: 1 }, { Id: 2 }] },
    { list: 'FAQCategories', id: 'z', items: [{ Id: 1, Title: 'cat' }] },
  ]);
  assert.equal(chunks.length, 0);
  assert.deepEqual(stats.unmapped, ['SomethingNew']);
  assert.equal(stats.skipped[0].list, 'HOPD');
  assert.equal(stats.skipped[0].rows, 2);
  assert.match(stats.skipped[0].reason, /Placeholder/);
});

test('inactive, empty and placeholder rows are dropped and listed', () => {
  const { chunks, stats } = extract([{ list: 'FAQQuestions', id: 'g', items: [
    { ...faqRow(1, 'Retired question?', 'Old.'), IsActive: false },
    { ...faqRow(2, 'Retired too?', 'Old.'), IsActive: 'No' },
    faqRow(3, '', ''),
    faqRow(4, 'Stub question?', 'Answer here.'),
    faqRow(5, 'Lorem', 'Lorem ipsum dolor sit amet'),
    { ...faqRow(6, 'Kept question?', 'Kept.'), IsActive: true },
  ] }]);
  assert.deepEqual(chunks.map((c) => c.id), ['FAQQuestions:6']);
  assert.deepEqual(stats.dropped, { inactive: 2, empty: 1, placeholder: 2 });
  assert.deepEqual(stats.droppedRows.map((r) => [r.why, r.id]), [['inactive', 1], ['inactive', 2], ['empty', 3], ['placeholder', 4], ['placeholder', 5]]);
});

test('the same Q&A copied into two lists is kept once, with the other place recorded', () => {
  const row = faqRow(1, 'Where are tip sheets?', 'On the Tip Sheets page.');
  const { chunks, stats } = extract([
    { list: 'FAQQuestions', id: 'a', items: [row] },
    { list: 'FAQThriveQuestions', id: 'b', items: [{ ...row, Id: 9 }] },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].alsoIn, ['FAQThriveQuestions:9']);
  assert.equal(stats.dropped.duplicate, 1);
  assert.equal(stats.droppedRows.length, 0, 'duplicates are not reported as dropped content');
});

test('rows hidden on the live site are kept but flagged published:false', () => {
  const { chunks, stats } = extract([{ list: 'EpicUpgrades', id: 'g', items: [
    { Id: 1, Title: 'Beaker', field_4: 'Lab system', Display: ['Yes-vNov2024', 'no'] },
    { Id: 2, Title: 'Cupid', field_4: 'Cardiology', Display: 'no' },
    { Id: 3, Title: 'Willow', field_4: 'Pharmacy' },
  ] }]);
  assert.equal(stats.unpublished, 1);
  assert.deepEqual(chunks.map((c) => [c.title, c.meta?.published]), [['Beaker', undefined], ['Cupid', false], ['Willow', undefined]]);
});

test('plain-text columns are entity-decoded once; body that starts with the title is not repeated', () => {
  const { chunks } = extract([{ list: 'Terminology', id: 'g', items: [
    { Id: 1, EpicTerm: 'In Basket', Definition: 'In Basket &#39;messages&#39; &amp;amp; tasks' },
    { Id: 2, EpicTerm: 'Chart', AxiumTerm: 'Patient record', Definition: 'Chart review.' },
  ] }]);
  assert.equal(chunks[0].text, "In Basket 'messages' &amp; tasks", 'body starts with the title, so the title is not prepended');
  assert.equal(chunks[1].title, 'Chart (axiUm equivalent: Patient record)');
  assert.equal(chunks[1].kind, 'glossary');
});

test('a list with a rule but no build() is an error, not a silent skip', () => {
  LISTS.__brokenForTest = { kind: 'x' };
  try {
    assert.throws(() => extract([{ list: '__brokenForTest', id: 'g', items: [{ Id: 1 }] }]), /No build\(\)/);
  } finally { delete LISTS.__brokenForTest; }
});
