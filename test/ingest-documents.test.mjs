// Covers: Turning document library files into search passages (PDF, Word, PowerPoint, Excel, text, calendar invites, images), and refusing SharePoint's throttling page saved in place of a real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { ingestDocuments, isIncompleteDownload } from '../src/ingest/documents.mjs';

// ---------------------------------------------------------------- fixtures

/** A minimal valid PDF, one page per string, with a correct xref table. */
function pdfOf(pages) {
  const objs = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const content = `BT /F1 12 Tf 50 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function docxOf(paragraphs) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map(([style, text]) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pptxOf(slides) {
  const zip = new JSZip();
  const para = (t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  slides.forEach(({ lines, notes }, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:txBody>${lines.map(para).join('')}</p:txBody></p:sld>`);
    if (notes) zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<p:notes>${para(notes)}${para(String(i + 1))}</p:notes>`);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function xlsxOf(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Classes');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const THROTTLE_PAGE = Buffer.from('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">\r\n<html><head><script src="throttleerror.js"></script><title id="errorpagetitle"></title></head><body id="ms-error-body"></body></html>');

/**
 * A site folder: files.json plus files/. Each entry: { name, folder?, library?, data?, size? }.
 * `size` defaults to the data's length (what SharePoint reports for the real file).
 */
function site(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'sophia-docs-'));
  const manifest = entries.map((e) => {
    const folder = e.folder ?? 'Shared Documents';
    const path = `/sites/BetterCare/${folder}/${e.name}`;
    if (e.data) {
      const local = join(dir, 'files', folder, e.name);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, e.data);
    }
    return { name: e.name, path, size: e.size ?? e.data?.length ?? 1234, library: e.library ?? 'Documents', modified: '2026-08-15T12:00:00Z', etag: e.etag ?? '"1"' };
  });
  writeFileSync(join(dir, 'files.json'), JSON.stringify(manifest));
  return dir;
}

const byTitle = (chunks, title) => chunks.filter((c) => c.title === title);

// ---------------------------------------------------------------- the throttle check

test('isIncompleteDownload: a real file of the reported size passes', () => {
  const pdf = pdfOf(['Hello']);
  assert.equal(isIncompleteDownload(pdf, pdf.length, 'pdf'), false);
});

test('isIncompleteDownload: SharePoint\'s HTML throttling page saved as a .pdf is rejected', () => {
  assert.equal(isIncompleteDownload(THROTTLE_PAGE, 48213, 'pdf'), true);
});

test('isIncompleteDownload: a truncated non-Office file is rejected even if it is not HTML', () => {
  const pdf = pdfOf(['Hello']);
  assert.equal(isIncompleteDownload(pdf.subarray(0, 100), pdf.length, 'pdf'), true);
});

test('isIncompleteDownload: an Office file whose size differs but is a real zip passes (re-stamped on download)', async () => {
  const docx = await docxOf([[null, 'Hi']]);
  assert.equal(isIncompleteDownload(docx, docx.length + 517, 'docx'), false);
});

test('isIncompleteDownload: an Office file that is really the HTML throttling page is rejected', () => {
  for (const ext of ['docx', 'pptx', 'xlsx']) assert.equal(isIncompleteDownload(THROTTLE_PAGE, 90210, ext), true, ext);
  assert.equal(isIncompleteDownload(Buffer.concat([Buffer.from('  \r\n'), THROTTLE_PAGE]), 90210, 'docx'), true, 'leading whitespace');
});

test('isIncompleteDownload: unknown expected size is never incomplete', () => {
  assert.equal(isIncompleteDownload(THROTTLE_PAGE, 0, 'pdf'), false);
  assert.equal(isIncompleteDownload(THROTTLE_PAGE, undefined, 'pdf'), false);
});

test('regression: a throttled download is reported missing, not indexed as the document', async () => {
  const dir = site([{ name: 'Upgrade Guide.pdf', data: THROTTLE_PAGE, size: 48213 }]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.equal(chunks.length, 0);
    assert.deepEqual(report.missing, ['Shared Documents/Upgrade Guide.pdf (incomplete download)']);
    assert.equal(report.extracted, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

// ---------------------------------------------------------------- extraction by type

test('PDF: one section per page, links jump to the page', async () => {
  const text1 = 'Haiku lets providers review the schedule and chart from a phone. '.repeat(2);
  const text2 = 'Use Secure Chat to message the care team about a patient quickly. '.repeat(2);
  const dir = site([{ name: 'Haiku_Quick-Start  Guide.pdf', data: pdfOf([text1, text2]) }]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.equal(report.extracted, 1);
    assert.equal(chunks.length, 2);
    const [a, b] = chunks;
    assert.equal(a.title, 'Haiku Quick-Start Guide');
    assert.equal(a.kind, 'document');
    assert.equal(a.sourceType, 'document');
    assert.equal(a.id, 'file:Shared Documents/Haiku_Quick-Start  Guide.pdf#0');
    assert.deepEqual(a.headingPath, ['Page 1']);
    assert.match(a.text, /Haiku lets providers/);
    assert.match(a.url, /Haiku_Quick-Start%20%20Guide\.pdf#page=1$/);
    assert.match(b.localUrl, /^\/sites\/BetterCare\/.*#page=2$/);
    assert.deepEqual({ ...a.meta, size: undefined }, { file: 'Haiku_Quick-Start  Guide.pdf', folder: 'Shared Documents', type: 'pdf', modified: '2026-08-15', size: undefined, page: 1 });
    assert.equal(a.list, 'Documents');
  } finally { rmSync(dir, { recursive: true }); }
});

test('PDF with almost no text is flagged as scanned and uses the OCR transcription when there is one', async () => {
  const scanned = pdfOf(['x']);
  const dir = site([{ name: 'Scan.pdf', data: scanned }]);
  const ocrFile = join(dir, 'ocr.json');
  writeFileSync(ocrFile, JSON.stringify({ [`/sites/BetterCare/Shared Documents/Scan.pdf|${scanned.length}`]: { text: 'Transcribed badge instructions for the new Imprivata readers.' } }));
  try {
    const { chunks, report } = await ingestDocuments(dir, { ocrFile });
    assert.deepEqual(report.noText, ['Shared Documents/Scan.pdf']);
    assert.equal(report.ocr, 1);
    assert.equal(chunks[0].text, 'Transcribed badge instructions for the new Imprivata readers.');
  } finally { rmSync(dir, { recursive: true }); }
});

test('Word: headings become sections', async () => {
  const docx = await docxOf([['Heading1', 'Signing in'], [null, 'Use your UT Health credentials to sign in to Epic.'], ['Heading1', 'Getting help'], [null, 'Call the help desk.']]);
  const dir = site([{ name: 'Guide.docx', data: docx }]);
  try {
    const { chunks } = await ingestDocuments(dir);
    assert.deepEqual(chunks.map((c) => [c.headingPath[0], c.text]), [
      ['Signing in', 'Use your UT Health credentials to sign in to Epic.'],
      ['Getting help', 'Call the help desk.'],
    ]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('PowerPoint: one section per slide in slide order, with speaker notes', async () => {
  const slides = Array.from({ length: 11 }, (_, i) => ({ lines: [`Slide title ${i + 1}`, `Body ${i + 1}`], notes: i === 0 ? 'Say hello first' : null }));
  const dir = site([{ name: 'Deck.pptx', data: await pptxOf(slides) }]);
  try {
    const { chunks } = await ingestDocuments(dir);
    assert.ok(chunks.every((c) => c.kind === 'slides'));
    const all = chunks.map((c) => c.text).join('\n');
    assert.match(all, /Slide title 1\nBody 1\nSpeaker notes: Say hello first/);
    assert.doesNotMatch(all, /Speaker notes: Say hello first 1/, 'slide-number placeholders are dropped from notes');
    // slide10 sorts after slide9 (numeric, not text, order)
    assert.ok(all.indexOf('Slide title 9') < all.indexOf('Slide title 10'));
    assert.equal(chunks[0].url.includes('#page='), false, 'only PDFs get page anchors');
  } finally { rmSync(dir, { recursive: true }); }
});

test('Excel: one section per sheet, cells joined with |', async () => {
  const dir = site([{ name: 'Classes.xlsx', data: await xlsxOf([['Class', 'Date'], ['Epic 101', new Date('2026-10-01T00:00:00Z')], [null, null]]) }]);
  try {
    const { chunks } = await ingestDocuments(dir);
    assert.equal(chunks[0].kind, 'spreadsheet');
    assert.deepEqual(chunks[0].headingPath, ['Sheet: Classes']);
    assert.match(chunks[0].text, /^Class \| Date\nEpic 101 \| /);
  } finally { rmSync(dir, { recursive: true }); }
});

test('text, CSV, HTML and calendar invites', async () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Epic Open Lab\nDTSTART;TZID=America/Chicago:20261020T090000\nLOCATION:Room 2.100\nDESCRIPTION:Bring your badge\\nand laptop\nEND:VEVENT\nEND:VCALENDAR';
  const dir = site([
    { name: 'notes.txt', data: Buffer.from('Plain   text notes about downtime procedures.') },
    { name: 'roster.csv', data: Buffer.from('name,role\nAnn,RN') },
    { name: 'page.html', data: Buffer.from('<html><head><title>Saved page</title></head><body><p>Saved page body text.</p></body></html>') },
    { name: 'lab.ics', data: Buffer.from(ics) },
  ]);
  try {
    const { chunks } = await ingestDocuments(dir);
    assert.equal(byTitle(chunks, 'notes')[0].text, 'Plain text notes about downtime procedures.');
    assert.equal(byTitle(chunks, 'roster')[0].kind, 'spreadsheet');
    assert.deepEqual(byTitle(chunks, 'page')[0].headingPath, ['Saved page']);
    assert.equal(byTitle(chunks, 'page')[0].text, 'Saved page body text.');
    const ev = byTitle(chunks, 'lab')[0];
    assert.deepEqual(ev.headingPath, ['Calendar invite']);
    assert.equal(ev.text, 'Epic Open Lab\nStarts 20261020T090000\nLocation: Room 2.100\nBring your badge\nand laptop');
  } finally { rmSync(dir, { recursive: true }); }
});

// ---------------------------------------------------------------- what gets left out or cataloged

test('images and video are findable by name and folder; Site Assets media and page libraries are skipped', async () => {
  const dir = site([
    { name: 'Abridge_Flyer.png', folder: 'Images/Abridge' },
    { name: 'Demo.mp4' },
    { name: 'Voice.m4a' },
    { name: 'Logo.png', library: 'Site Assets', folder: 'SiteAssets' },
    { name: 'Home.aspx', library: 'Site Pages', folder: 'SitePages' },
    { name: 'Thing.zip' },
  ]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.equal(report.skippedAssets, 1);
    assert.equal(report.cataloged, 4);
    const flyer = byTitle(chunks, 'Abridge Flyer')[0];
    assert.equal(flyer.kind, 'file');
    assert.equal(flyer.text, 'Image: Abridge Flyer\nFolder: Images/Abridge\nFile name: Abridge_Flyer.png');
    assert.match(byTitle(chunks, 'Demo')[0].text, /^Video: /);
    assert.match(byTitle(chunks, 'Voice')[0].text, /^Audio recording: /);
    assert.match(byTitle(chunks, 'Thing')[0].text, /^ZIP file: /);
    assert.equal(byTitle(chunks, 'Home').length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test('an image with an OCR transcription carries the transcription', async () => {
  const dir = site([{ name: 'Poster.png', size: 500 }]);
  const ocrFile = join(dir, 'ocr.json');
  writeFileSync(ocrFile, JSON.stringify({ '/sites/BetterCare/Shared Documents/Poster.png|500': { text: 'Go-live is November 7.' } }));
  try {
    const { chunks, report } = await ingestDocuments(dir, { ocrFile });
    assert.match(chunks[0].text, /Go-live is November 7\.$/);
    assert.equal(chunks[0].meta.ocr, true);
    assert.equal(report.ocr, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test('test files and folders, placeholder text, and missing files are reported, not indexed', async () => {
  const dir = site([
    { name: 'Guide.txt', folder: 'Shared Documents/Test', data: Buffer.from('Real looking text in a test folder.') },
    { name: 'mary-test.txt', data: Buffer.from('Some text here.') },
    { name: 'Stub.txt', data: Buffer.from('testing 123') },
    { name: 'Gone.pdf' },
    { name: 'Latest news.txt', data: Buffer.from('The latest Epic news for providers this month.') },
  ]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.deepEqual(report.testContent, [
      'Shared Documents/Test/Guide.txt (“Test”)',
      'Shared Documents/mary-test.txt (“mary-test.txt”)',
      'Shared Documents/Stub.txt (placeholder text)',
    ]);
    assert.deepEqual(report.missing, ['Shared Documents/Gone.pdf']);
    assert.deepEqual(chunks.map((c) => c.title), ['Latest news']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('identical copies are indexed once, with the other locations recorded', async () => {
  const body = Buffer.from('The downtime procedure: print the census, use paper orders, and call the help desk.');
  const dir = site([{ name: 'Downtime.txt', data: body }, { name: 'Downtime copy.txt', folder: 'Archive', data: body }]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.equal(chunks.length, 1);
    assert.equal(report.duplicates, 1);
    assert.deepEqual(chunks[0].meta.copies, ['https://uthealthsa.sharepoint.com/sites/BetterCare/Archive/Downtime%20copy.txt']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a file that fails to parse is reported as failed', async () => {
  const dir = site([{ name: 'Broken.docx', data: Buffer.from('PK\u0003\u0004 not really a zip file at all') }]);
  try {
    const { chunks, report } = await ingestDocuments(dir);
    assert.equal(chunks.length, 0);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0], /^Shared Documents\/Broken\.docx: /);
  } finally { rmSync(dir, { recursive: true }); }
});

test('an empty document is still findable by name', async () => {
  const dir = site([{ name: 'Blank.docx', data: await docxOf([]) }]);
  try {
    const { chunks } = await ingestDocuments(dir);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /^Document: Blank\nFolder: Shared Documents\n\(No extractable text/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('extraction is cached by path, size and etag; a changed etag re-parses', async () => {
  const dir = site([{ name: 'Tip.txt', data: Buffer.from('Original tip sheet text.'), etag: '"1"' }]);
  const cacheFile = join(dir, 'cache', 'extract-cache.json');
  const local = join(dir, 'files', 'Shared Documents', 'Tip.txt');
  try {
    await ingestDocuments(dir, { cacheFile });
    assert.ok(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8'))).length === 1);
    writeFileSync(local, 'Replaced tip sheet text.');               // same length, same etag
    assert.equal((await ingestDocuments(dir, { cacheFile })).chunks[0].text, 'Original tip sheet text.', 'cache hit');
    const m = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8'));
    m[0].etag = '"2"';
    writeFileSync(join(dir, 'files.json'), JSON.stringify(m));
    assert.equal((await ingestDocuments(dir, { cacheFile })).chunks[0].text, 'Replaced tip sheet text.', 'new etag re-parses');
  } finally { rmSync(dir, { recursive: true }); }
});
