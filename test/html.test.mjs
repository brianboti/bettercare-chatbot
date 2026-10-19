// Covers: Turning SharePoint's rich-text HTML into plain text: decoding entities, keeping links, and tidying whitespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, normalize } from '../src/html.mjs';

test('decodeEntities: numeric, hex and named entities', () => {
  assert.equal(decodeEntities('a&#58;b &#x41;&#x42;'), 'a:b AB');
  assert.equal(decodeEntities('Tom &amp; Jerry &lt;3 &quot;hi&quot; it&apos;s'), 'Tom & Jerry <3 "hi" it\'s');
  assert.equal(decodeEntities('&ndash;&mdash;&rsquo;&lsquo;&ldquo;&rdquo;&hellip;&bull;'), '–—’‘“”…•');
  assert.equal(decodeEntities('&NBSP;'), ' ', 'named entities ignore case');
});

test('decodeEntities: unknown named entities are left alone', () => {
  assert.equal(decodeEntities('&copy; &notreal;'), '&copy; &notreal;');
});

test('htmlToText: empty input gives empty text and no links', () => {
  assert.deepEqual(htmlToText(''), { text: '', links: [] });
  assert.deepEqual(htmlToText(null), { text: '', links: [] });
});

test('htmlToText: blocks become lines, list items become bullets, table cells stay apart', () => {
  const { text } = htmlToText('<div class="ExternalClass1"><p>First</p><p>Second<br>line</p><ul><li>One</li><li>Two</li></ul><table><tr><td>A</td><td>B</td></tr></table></div>');
  // Cells are tab-separated before normalize() folds the tab into a space;
  // list items end up a blank line apart (</li> and the next <li> both break).
  assert.equal(text, 'First\nSecond\nline\n\n- One\n\n- Two\nA B');
});

test('htmlToText: links are collected with their labels; in-page anchors are not', () => {
  const { text, links } = htmlToText('See <a href="https://x.org/tip.pdf">the <b>tip sheet</b></a> or <a href="#top">top</a>.');
  assert.equal(text, 'See the tip sheet or top.');
  assert.deepEqual(links, [{ text: 'the tip sheet', url: 'https://x.org/tip.pdf' }]);
});

test('htmlToText: a link with no label shows its address', () => {
  const { text, links } = htmlToText('<a href="https://x.org/a"></a>');
  assert.equal(text, 'https://x.org/a');
  assert.deepEqual(links, [{ text: '', url: 'https://x.org/a' }]);
});

test('htmlToText: entity-encoded markup (SharePoint double encoding) is decoded before parsing', () => {
  assert.equal(htmlToText('&lt;p&gt;Hello&lt;/p&gt;&lt;p&gt;World&lt;/p&gt;').text, 'Hello\nWorld');
});

test('normalize: zero-width characters, non-breaking spaces and runs of whitespace', () => {
  assert.equal(normalize('a​b﻿  c\t\td'), 'ab c d');
  assert.equal(normalize('  one  \n   two\n\n\n\nthree  '), 'one\ntwo\n\nthree');
  assert.equal(normalize(42), '42');
});
