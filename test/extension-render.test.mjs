// Covers: Drawing an answer on screen (extension/lib/render.js): paragraphs, bullet and numbered lists, bold, code, links and clickable [n] citations, without ever running HTML from the model.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

let renderAnswer;
before(async () => {
  globalThis.document = parseHTML('<!doctype html><html><body></body></html>').document;
  ({ renderAnswer } = await import('../extension/lib/render.js'));
});

/** Render into a <div> and return it. */
function render(text, cite = (n) => { const a = document.createElement('a'); a.className = 'cite'; a.textContent = String(n); return a; }) {
  const div = document.createElement('div');
  div.append(renderAnswer(text, cite));
  return div;
}

test('paragraphs: blank lines split them, single newlines join', () => {
  const d = render('First line\nsame paragraph\n\nSecond paragraph');
  const ps = [...d.querySelectorAll('p')].map((p) => p.textContent);
  assert.deepEqual(ps, ['First line same paragraph', 'Second paragraph']);
});

test('bullet and numbered lists, and switching between them', () => {
  const d = render('Steps:\n1. Open Epic\n2) Click Chart\n- a note\n* another\n• third');
  assert.equal(d.children[0].tagName.toLowerCase(), 'p');
  const ol = d.querySelector('ol'), ul = d.querySelector('ul');
  assert.deepEqual([...ol.children].map((li) => li.textContent), ['Open Epic', 'Click Chart']);
  assert.deepEqual([...ul.children].map((li) => li.textContent), ['a note', 'another', 'third']);
  assert.deepEqual([...d.children].map((n) => n.tagName.toLowerCase()), ['p', 'ol', 'ul']);
});

test('a paragraph after a list ends the list', () => {
  const d = render('- one\n- two\nAfter the list');
  assert.deepEqual([...d.children].map((n) => n.tagName.toLowerCase()), ['ul', 'p']);
});

test('headings become h4', () => {
  const d = render('## Before you start\nText');
  assert.equal(d.querySelector('h4').textContent, 'Before you start');
});

test('bold, code and links', () => {
  const d = render('Use **Haiku** and type `.SMARTPHRASE` at https://example.org/tips.');
  assert.equal(d.querySelector('strong').textContent, 'Haiku');
  assert.equal(d.querySelector('code').textContent, '.SMARTPHRASE');
  const a = d.querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://example.org/tips.');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener');
});

test('citations go through the cite callback, inside bold too, and fall back to [n] text', () => {
  const d = render('See this [1] and **that [2]**, both [3, 4].');
  assert.deepEqual([...d.querySelectorAll('a.cite')].map((a) => a.textContent), ['1', '2', '3', '4']);
  assert.ok(d.querySelector('strong a.cite'), 'a citation inside bold is still a link');

  const plain = render('Unknown source [9].', () => null);
  assert.equal(plain.textContent, 'Unknown source [9].');
  assert.equal(plain.querySelector('a'), null);
});

test('HTML in the model output is shown as text, never run', () => {
  const d = render('<img src=x onerror="alert(1)"> **<script>bad()</script>**\n- <b>not bold</b>');
  assert.equal(d.querySelector('img'), null);
  assert.equal(d.querySelector('script'), null);
  assert.equal(d.querySelector('b'), null);
  assert.match(d.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.match(d.querySelector('li').textContent, /<b>not bold<\/b>/);
});

test('only http(s) text becomes a link (no javascript: URLs)', () => {
  const d = render('javascript:alert(1) and ftp://x');
  assert.equal(d.querySelector('a'), null);
});

test('carriage returns and empty input', () => {
  assert.deepEqual([...render('one\r\n\r\ntwo').querySelectorAll('p')].map((p) => p.textContent), ['one', 'two']);
  assert.equal(render('').childNodes.length, 0);
  assert.equal(render('\n\n  \n').childNodes.length, 0);
});

test('re-rendering a growing answer gives the same structure as rendering it whole', () => {
  const full = 'Intro [1]\n\n- step one\n- step **two** [2]';
  let shown;
  for (let i = 1; i <= full.length; i++) shown = render(full.slice(0, i));
  assert.equal(shown.innerHTML, render(full).innerHTML);
});
