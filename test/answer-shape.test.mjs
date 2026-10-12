// Covers: The shape every answer must have: the assumptions block cut out of the stream, a citation on every bullet, and the help-desk line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssumptionSplitter, parseAssumptions } from '../server/followups.mjs';
import { repairCitations, uncitedItems } from '../server/citations.mjs';
import { helpLine, hasHelp, withHelpSource, HELP_SOURCE_ID } from '../server/help.mjs';

function run(pieces) {
  let got = null;
  const s = new AssumptionSplitter((a) => { got = a; });
  const shown = pieces.map((p) => s.push(p)).join('') + s.finish();
  return { shown, assumptions: got };
}

test('cuts the assumptions block out of the start of the answer, even split across tokens', () => {
  const r = run(['\n<assum', 'ptions>\nYou\'re using ProcDoc in Epic | I\'m not using ProcDoc\n- You don\'t have macros', ' yet | I already have macros\n</assumptions>\n\nType **.procdoc** [2].']);
  assert.equal(r.shown, 'Type **.procdoc** [2].');
  assert.deepEqual(r.assumptions, [
    { text: "You're using ProcDoc in Epic", fix: "I'm not using ProcDoc" },
    { text: "You don't have macros yet", fix: 'I already have macros' },
  ]);
});

test('an answer without the block streams through untouched', () => {
  const r = run(['<b', 'r> no, ', 'Call the help desk [1].']);
  assert.equal(r.shown, '<br> no, Call the help desk [1].');
  assert.equal(r.assumptions, null);
  assert.equal(run(['Call', ' us']).shown, 'Call us');
});

test('an assumption without a correction keeps its text', () => {
  assert.deepEqual(parseAssumptions('<assumptions>\nYou\'re asking about UT Health\n</assumptions>'), [{ text: "You're asking about UT Health", fix: null }]);
  assert.deepEqual(parseAssumptions('no block'), []);
});

const EXCERPTS = [
  { title: 'Thrive Learning Objs', text: 'Beyond the Basics: Create and edit NoteWriter macros for faster documentation. Follow another user\'s macros. Copy and customize existing SmartLists to fit your specific needs. Utilize keyboard shortcuts.' },
  { title: 'Phase 3 ProcDoc Dermatology', text: 'By typing .procdoc in a note (or if available, a Procedures button may already be built in your Notes Activity) you select the procedure and fill in the form using speed buttons and free text.' },
  { title: 'BetterCare site footer — help desk contacts', text: 'Epic IT Help Desk: (210) 450-4800 or 210-450-HELP' },
];

test('bullets under a cited lead-in get their own citation (the SmartList answer)', () => {
  const answer = [
    'For ProcDoc specifically, the Thrive "Beyond the Basics" objectives cover the fixes [1]:',
    '',
    '- Create and edit NoteWriter macros for faster documentation.',
    '- Copy and customize existing SmartLists to fit your needs.',
    '- Check whether a Procedures button is already built into your Notes Activity [2].',
  ].join('\n');
  assert.equal(uncitedItems(answer).length, 2);
  const r = repairCitations(answer, EXCERPTS);
  assert.equal(r.added, 2);
  assert.deepEqual(uncitedItems(r.text), []);
  assert.match(r.text, /faster documentation \[1\]\./);
  assert.match(r.text, /SmartLists to fit your needs \[1\]\./);
});

test('a bare bullet is cited from the excerpt it matches best', () => {
  const r = repairCitations('1. Type .procdoc in a note, or use the Procedures button.\n2. Fill in the form with speed buttons and free text', EXCERPTS);
  assert.equal(r.text, '1. Type .procdoc in a note, or use the Procedures button [2].\n2. Fill in the form with speed buttons and free text [2]');
});

test('a bullet nothing supports is reported, not cited at random', () => {
  const r = repairCitations('- Restart your computer and clear the browser cache.', EXCERPTS);
  assert.equal(r.added, 0);
  assert.deepEqual(r.unresolved, ['Restart your computer and clear the browser cache.']);
});

test('questions back to the person need no citation', () => {
  assert.deepEqual(uncitedItems('Which do you use?\n- iPhone or Android?'), []);
});

test('the help line cites the footer, and is skipped when the answer already gives the number', () => {
  assert.match(helpLine(9), /210-450-4800.*\[9\]\.$/);
  assert.equal(hasHelp('Call 210.450-HELP for immediate help [3].'), true);
  assert.equal(hasHelp('Type .procdoc [2].'), false);
});

test('the footer excerpt is added once, last', () => {
  const footer = { id: HELP_SOURCE_ID, title: 'footer' };
  const retriever = { get: (id) => (id === HELP_SOURCE_ID ? footer : null) };
  assert.deepEqual(withHelpSource([{ id: 'a' }], retriever).map((c) => c.id), ['a', HELP_SOURCE_ID]);
  assert.deepEqual(withHelpSource([footer, { id: 'a' }], retriever).map((c) => c.id), [HELP_SOURCE_ID, 'a']);
});
