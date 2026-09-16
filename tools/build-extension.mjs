#!/usr/bin/env node
// Build the loadable extension payload:
//   1. extension/data/corpus.json  — compact search corpus from data/chunks.json
//   2. extension/icons/*.png       — toolbar icons, drawn here so the repo needs no binaries
//
//   node tools/build-extension.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = resolve(ROOT, 'extension');

// ---------------------------------------------------------------- corpus

const chunks = JSON.parse(readFileSync(resolve(ROOT, 'data/chunks.json'), 'utf8'));

// Keep only what the panel actually reads. Field names are short because this
// file ships inside the extension.
const corpus = chunks.map((c) => {
  const m = c.meta || {};
  const out = {
    i: c.id,
    t: c.title,
    x: c.text,
    l: c.list,
    k: c.kind,
    u: c.url,
  };
  if (m.category) out.c = m.category;
  if (m.roles) out.r = m.roles;
  if (m.audience) out.r = m.audience;
  if (m.date) out.d = m.date;
  if (m.published === false) out.h = 1;          // hidden on the live site
  if (m.documentUrl) out.doc = m.documentUrl;
  else if (c.links && c.links[0]) out.doc = c.links[0].url;
  return out;
});

mkdirSync(resolve(EXT, 'data'), { recursive: true });
writeFileSync(resolve(EXT, 'data/corpus.json'), JSON.stringify(corpus), 'utf8');

// ---------------------------------------------------------------- icons
// A tiny PNG encoder. Shapes are drawn with 3x3 supersampled coverage so the
// mark stays clean at 16px.

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                        // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                                        // bit depth
  ihdr[9] = 6;                                        // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.sqrt(dx * dx + dy * dy) - r;
}

function inTriangle(px, py, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const SS = 3;                                       // supersample factor

  // Blend a colour into the pixel using coverage `a`.
  const put = (idx, rgb, a) => {
    if (a <= 0) return;
    const inv = 1 - a;
    buf[idx]     = Math.round(buf[idx]     * inv + rgb[0] * a);
    buf[idx + 1] = Math.round(buf[idx + 1] * inv + rgb[1] * a);
    buf[idx + 2] = Math.round(buf[idx + 2] * inv + rgb[2] * a);
    buf[idx + 3] = Math.round(buf[idx + 3] * inv + 255    * a);
  };

  const teal  = hex('#127D94');
  const white = hex('#FFFFFF');
  const amber = hex('#E09A4E');

  // Speech-bubble tail, in unit coords scaled to S.
  const tail = [[0.30, 0.60], [0.44, 0.60], [0.31, 0.80]].map(([x, y]) => [x * S, y * S]);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let covBg = 0, covBubble = 0, covTail = 0, covDot = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (sdRoundRect(px, py, 0, 0, S, S, S * 0.23) < 0) covBg++;
          if (sdRoundRect(px, py, S * 0.20, S * 0.22, S * 0.60, S * 0.40, S * 0.11) < 0) covBubble++;
          if (inTriangle(px, py, tail[0], tail[1], tail[2])) covTail++;
          const ddx = px - S * 0.735, ddy = py - S * 0.715;
          if (Math.sqrt(ddx * ddx + ddy * ddy) < S * 0.10) covDot++;
        }
      }
      const n = SS * SS;
      const idx = (y * S + x) * 4;
      put(idx, teal,  covBg / n);
      put(idx, white, Math.max(covBubble, covTail) / n * (covBg / n));
      put(idx, amber, covDot / n * (covBg / n));
    }
  }
  return encodePng(S, buf);
}

mkdirSync(resolve(EXT, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(EXT, `icons/icon${size}.png`), drawIcon(size));
}

const bytes = JSON.stringify(corpus).length;
console.log(`corpus.json  ${corpus.length} chunks, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`icons        16, 32, 48, 128 px`);
console.log(`\nLoad it: chrome://extensions -> Developer mode -> Load unpacked -> ${EXT}`);
