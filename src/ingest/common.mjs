// Shared pieces of the ingestion pipeline: the chunk shape, text cleanup,
// DOM-to-text, and section-aware chunking. Pure functions, no I/O.

import { createHash } from 'node:crypto';
import { decodeEntities } from '../html.mjs';

export const SITE = 'https://uthealthsa.sharepoint.com/sites/BetterCare';
export const ORIGIN = 'https://uthealthsa.sharepoint.com';

// Target chunk size in words (~1.3 tokens/word). Small enough that a citation
// points at something specific, big enough to carry a full answer.
export const CHUNK_WORDS = 280;
export const OVERLAP_WORDS = 40;

export const sha = (s, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);

export function clean(s) {
  return decodeEntities(String(s ?? ''))
    .replace(/[​-‍﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Absolute, browser-openable URL for a server-relative SharePoint path. */
export const spUrl = (path) => `${ORIGIN}${encodeURI(path).replace(/#/g, '%23')}`;

const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL', 'BR', 'HR', 'FIGCAPTION', 'DT', 'DD', 'HEADER', 'FOOTER']);

/** innerText-ish for linkedom: newlines at block boundaries, bullets for <li>. */
export function textOf(node) {
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.textContent; return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return;
    if (n.getAttribute?.('aria-hidden') === 'true') return;
    const block = BLOCK.has(tag);
    if (block) out += '\n';
    if (tag === 'LI') out += '- ';
    if (tag === 'TD' || tag === 'TH') out += ' | ';
    for (const c of n.childNodes) walk(c);
    if (block) out += '\n';
  };
  walk(node);
  return tidy(out);
}

/**
 * Tables and step lists leave orphan markers ("|", "-", "1.") on their own
 * lines; fold numbered markers into the following line and drop the rest.
 */
export function tidy(text) {
  const lines = clean(text).split('\n').map((l) => l.replace(/^\|\s*|\s*\|$/g, '').trim());
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\d+[.)]$/.test(l) && lines[i + 1]) { lines[i + 1] = `${l} ${lines[i + 1].replace(/^- /, '')}`; continue; }
    if (/^[\s|\-\u2022.]*$/.test(l)) continue;
    kept.push(l);
  }
  return kept.join('\n');
}

/** Make site-relative links absolute so they work from anywhere. */
export const absUrl = (u) => (u && u.startsWith('/') ? `${ORIGIN}${u}` : u);

/**
 * Split sections into chunks. Never merges across sections; overlap only
 * within a section. Each chunk carries its heading path.
 *
 * @param {{ heading?: string, text: string }[]} sections
 * @returns {{ headingPath: string[], text: string }[]}
 */
export function chunkSections(sections, { words = CHUNK_WORDS, overlap = OVERLAP_WORDS } = {}) {
  const out = [];
  // Merge tiny adjacent sections under the same heading so one-line web parts
  // don't each become a chunk.
  const merged = [];
  for (const s of sections) {
    const text = tidy(s.text);
    if (!text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.heading === s.heading && wc(prev.text) + wc(text) < words) prev.text += `\n${text}`;
    else merged.push({ heading: s.heading, text });
  }
  for (const s of merged) {
    const headingPath = s.heading ? [s.heading] : [];
    const paras = s.text.split('\n').flatMap((p) => (wc(p) > words ? splitLong(p, words) : [p]));
    let buf = [];       // paragraphs in the current chunk
    let fresh = 0;      // how many of them are new (not overlap carried over)
    const size = () => buf.reduce((a, p) => a + wc(p), 0);
    for (const p of paras) {
      if (buf.length && fresh && size() + wc(p) > words) {
        out.push({ headingPath, text: buf.join('\n') });
        const tail = [];
        for (let i = buf.length - 1, t = 0; i >= 0 && t + wc(buf[i]) <= overlap; i--) { tail.unshift(buf[i]); t += wc(buf[i]); }
        buf = tail; fresh = 0;
      }
      buf.push(p); fresh++;
    }
    if (fresh) out.push({ headingPath, text: buf.join('\n') });
  }
  return out;
}

const wc = (s) => (s.match(/\S+/g) || []).length;

function splitLong(p, words) {
  const sentences = p.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [p];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (wc(buf) + wc(s) > words && buf) { out.push(buf.trim()); buf = ''; }
    if (wc(s) > words) {
      const w = s.split(/\s+/);
      for (let i = 0; i < w.length; i += words) out.push(w.slice(i, i + words).join(' '));
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
