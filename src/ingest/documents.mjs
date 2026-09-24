// Document libraries -> chunks.
//
// Every file in files.json becomes either content chunks (PDF, Word,
// PowerPoint, Excel, text) or, for media, one "file" chunk describing it by
// name and location — so "find the Abridge flyer" works even though an image
// has no text. Extraction results are cached per file (by size + etag) in
// data/index/extract-cache.json, so re-runs only parse what changed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { parseHTML } from 'linkedom';
import { clean, textOf, chunkSections, spUrl, sha } from './common.mjs';

const SITE_PATH = '/sites/BetterCare/';

const TEXT_TYPES = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'csv', 'md', 'html', 'htm', 'ics']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'psd', 'tif', 'tiff', 'heic']);
const MEDIA = new Set(['mp4', 'mov', 'm4v', 'webm', 'mp3', 'wav', 'm4a']);

const LIBRARY_LABEL = {
  Documents: 'Documents',
  'Refuel/Upgrade': 'Refuel/Upgrade library',
  Images: 'Images library',
  'Site Assets': 'Site Assets',
};

/** Human title from a file name: "Haiku_Quick-Start Guide.pdf" -> "Haiku Quick-Start Guide". */
const titleOf = (name) => clean(name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' '));

// ---------------------------------------------------------------- extractors
// Each returns sections: [{ heading, text, page? }]

async function pdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: false });
  return text.map((t, i) => ({ heading: `Page ${i + 1}`, text: clean(t), page: i + 1 }));
}

async function docx(buf) {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const sections = [];
  let heading = null, buf2 = [];
  const flush = () => { if (buf2.length) sections.push({ heading, text: buf2.join('\n') }); buf2 = []; };
  for (const el of document.body.children) {
    if (/^H[1-4]$/.test(el.tagName)) { flush(); heading = clean(el.textContent) || heading; }
    else { const t = textOf(el); if (t) buf2.push(t); }
  }
  flush();
  return sections;
}

async function pptx(buf) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const paras = (xml) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
    .map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''))
    .map(clean).filter(Boolean);
  const sections = [];
  for (const name of slideNames) {
    const n = Number(name.match(/\d+/g).pop());
    const lines = paras(await zip.file(name).async('string'));
    const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) {
      const nl = paras(await notes.async('string')).filter((l) => !/^\d+$/.test(l));
      if (nl.length) lines.push(`Speaker notes: ${nl.join(' ')}`);
    }
    if (lines.length) sections.push({ heading: `Slide ${n}: ${lines[0].slice(0, 80)}`, text: lines.join('\n'), page: n });
  }
  return sections;
}

async function xlsx(buf) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sections = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= 3000) return;
      const cells = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') return v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? (v instanceof Date ? v.toISOString().slice(0, 10) : '');
        return String(v);
      }).map((s) => clean(String(s)));
      if (cells.some(Boolean)) rows.push(cells.join(' | '));
    });
    if (rows.length) sections.push({ heading: `Sheet: ${ws.name}`, text: rows.join('\n') });
  });
  return sections;
}

async function plain(buf, ext) {
  const s = buf.toString('utf8');
  if (ext === 'html' || ext === 'htm') {
    const { document } = parseHTML(s);
    return [{ heading: clean(document.querySelector('title')?.textContent) || null, text: textOf(document.body || document.documentElement) }];
  }
  if (ext === 'ics') {
    const ev = [...s.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => {
      const f = (k) => (m[1].match(new RegExp(`^${k}[^:]*:(.*)$`, 'm')) || [])[1]?.trim();
      return [f('SUMMARY'), f('DTSTART') && `Starts ${f('DTSTART')}`, f('LOCATION') && `Location: ${f('LOCATION')}`, f('DESCRIPTION')?.replace(/\\n/g, '\n')].filter(Boolean).join('\n');
    });
    return [{ heading: 'Calendar invite', text: ev.join('\n\n') }];
  }
  return [{ heading: null, text: clean(s) }];
}

const EXTRACT = { pdf, docx, pptx, xlsx, txt: plain, csv: plain, md: plain, html: plain, htm: plain, ics: plain };

// ---------------------------------------------------------------- main

export async function ingestDocuments(siteDir, { cacheFile, ocrFile, log = () => {} } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(siteDir, 'files.json'), 'utf8'));
  const cache = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  // Transcriptions of images and scanned PDFs (tools/ocr-with-claude.mjs).
  const ocr = ocrFile && existsSync(ocrFile) ? JSON.parse(readFileSync(ocrFile, 'utf8')) : {};
  const ocrText = (f) => ocr[`${f.path}|${f.size}`]?.text || null;
  const report = { files: manifest.length, extracted: 0, cataloged: 0, skippedAssets: 0, duplicates: 0, noText: [], failed: [], missing: [] };
  const chunks = [];
  const byContent = new Map();       // text hash -> first chunk's sourceId (dedupe copies)
  let parsed = 0;

  for (const f of manifest) {
    const ext = extname(f.name).slice(1).toLowerCase();
    const rel = f.path.startsWith(SITE_PATH) ? f.path.slice(SITE_PATH.length) : f.path.replace(/^\//, '');
    const local = resolve(siteDir, 'files', rel);
    const sourceId = `file:${rel}`;
    const folder = dirname(rel);
    const title = titleOf(f.name);
    const base = {
      sourceId,
      sourceType: 'document',
      title,
      url: spUrl(f.path),
      localUrl: spUrl(f.path).replace(/^https:\/\/[^/]+/, ''),   // the replica serves the same paths
      list: LIBRARY_LABEL[f.library] || f.library,
      meta: { file: f.name, folder, type: ext, modified: f.modified?.slice(0, 10), size: f.size },
    };

    // Site Assets images/media are page decoration; the pages already cover them.
    if (f.library === 'Site Assets' && (IMAGE.has(ext) || MEDIA.has(ext) || !TEXT_TYPES.has(ext))) { report.skippedAssets++; continue; }
    if (f.library === 'Site Pages' || f.library === '_catalogs/hubsite' || f.library === 'Form Templates' || f.library === 'Style Library') continue;

    if (!TEXT_TYPES.has(ext)) {
      // Media and other binaries: findable by name and location.
      const what = IMAGE.has(ext) ? 'Image' : MEDIA.has(ext) ? (/(mp3|wav|m4a)/.test(ext) ? 'Audio recording' : 'Video') : `${ext.toUpperCase()} file`;
      const transcript = ocrText(f);
      const pieces = chunkSections([{ heading: null, text: `${what}: ${title}\nFolder: ${folder}\nFile name: ${f.name}${transcript ? `\n${transcript}` : ''}` }]);
      pieces.forEach((c, i) => chunks.push({ ...base, id: `${sourceId}#${i}`, kind: 'file', headingPath: [], text: c.text, meta: { ...base.meta, ocr: transcript ? true : undefined }, hash: sha(c.text) }));
      report.cataloged++;
      if (transcript) report.ocr = (report.ocr || 0) + 1;
      continue;
    }

    if (!existsSync(local)) { report.missing.push(rel); continue; }

    const key = `${f.path}|${f.size}|${f.etag || ''}`;
    let sections = cache[key];
    if (!sections) {
      try {
        const buf = readFileSync(local);
        // Office files are re-stamped on download, so their size can differ;
        // an HTML body is SharePoint's throttling page, never the real file.
        const htmlBody = buf.subarray(0, 64).toString('utf8').trimStart().startsWith('<');
        const office = ['docx', 'pptx', 'xlsx'].includes(ext);
        if (f.size && buf.length !== f.size && (!office || htmlBody)) { report.missing.push(`${rel} (incomplete download)`); continue; }
        sections = await EXTRACT[ext](buf, ext);
        cache[key] = sections;
        if (++parsed % 25 === 0) log(`  parsed ${parsed} documents…`);
      } catch (e) {
        report.failed.push(`${rel}: ${e.message.slice(0, 120)}`);
        continue;
      }
    }

    let allText = sections.map((s) => s.text).join('\n');
    const perPage = allText.length / Math.max(1, sections.length);
    if (ext === 'pdf' && perPage < 60) {
      report.noText.push(rel);                                     // likely scanned
      const transcript = ocrText(f);
      if (transcript) { sections = [{ heading: null, text: transcript }]; allText = transcript; report.ocr = (report.ocr || 0) + 1; }
    }

    // Byte-identical content stored in several places: index once, record copies.
    const contentKey = sha(allText, 16);
    if (allText.length > 40 && byContent.has(contentKey)) {
      const first = byContent.get(contentKey);
      (first.meta.copies ??= []).push(spUrl(f.path));
      report.duplicates++;
      continue;
    }

    const pieces = [];
    for (const s of sections) {
      for (const c of chunkSections([{ heading: s.heading, text: s.text }])) pieces.push({ ...c, page: s.page });
    }
    if (!pieces.length) {
      // No extractable text (scanned PDF, empty doc) — still findable by name.
      pieces.push({ headingPath: [], text: `Document: ${title}\nFolder: ${folder}\n(No extractable text — may be a scanned image.)` });
    }
    const kind = ext === 'pptx' ? 'slides' : ext === 'xlsx' || ext === 'csv' ? 'spreadsheet' : 'document';
    pieces.forEach((c, i) => {
      const chunk = {
        ...base,
        id: `${sourceId}#${i}`,
        kind,
        headingPath: c.headingPath,
        text: c.text,
        url: c.page && ext === 'pdf' ? `${base.url}#page=${c.page}` : base.url,
        localUrl: c.page && ext === 'pdf' ? `${base.localUrl}#page=${c.page}` : base.localUrl,
        meta: { ...base.meta, page: c.page },
        hash: sha(c.text),
      };
      chunks.push(chunk);
      if (i === 0) byContent.set(contentKey, chunk);
    });
    report.extracted++;
  }

  if (cacheFile) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return { chunks, report };
}
