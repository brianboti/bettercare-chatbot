// Loads the search corpus built by src/ingest/index.mjs and prepares each
// chunk's index text (what gets embedded and keyword-indexed).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHUNKS_FILE = resolve(ROOT, 'data/index/chunks.json');

export const KIND_LABEL = {
  page: 'Site page',
  news: 'News post',
  faq: 'FAQ',
  glossary: 'Glossary term (axiUm → Epic)',
  catalog: 'Tip sheet / training document listing',
  feature: 'Epic feature or upgrade change',
  event: 'Event / milestone',
  resource: 'Resource',
  announcement: 'Announcement',
  directory: 'Directory entry',
  document: 'Document',
  slides: 'Slide deck',
  spreadsheet: 'Spreadsheet',
  file: 'File',
};

/** "Roles: Patient Check-In" style facets from list metadata. */
function facets(m = {}) {
  const out = [];
  const add = (label, v) => {
    const vals = [].concat(v ?? []).map(String).filter((x) => x && x !== 'undefined');
    if (vals.length) out.push(`${label}: ${vals.join(', ')}`);
  };
  add('Application', m.application);
  add('Module', m.module);
  add('Upgrade', [].concat(m.upgrade ?? [], m.phase ?? []));
  add('Audience', m.audience);
  add('Roles', m.roles);
  add('Groups', m.groups);
  add('Service line', m.serviceLine);
  add('Tags', m.tags);
  add('Status', m.state ?? m.status);
  add('Date', m.date);
  add('Location', m.location);
  add('Format', m.format);
  add('Epic term', m.epicTerm);
  add('axiUm term', m.axiumTerm);
  return out;
}

export function loadChunks() {
  if (!existsSync(CHUNKS_FILE)) {
    throw new Error(`No corpus at ${CHUNKS_FILE}. Run: npm run ingest`);
  }
  const raw = JSON.parse(readFileSync(CHUNKS_FILE, 'utf8'));
  return raw.map((c) => {
    const where = [c.title, ...(c.headingPath || [])].filter(Boolean).join(' > ');
    // Header lines give short chunks ("Beaker — Lab System") enough context to
    // be findable, and tell the embedder what kind of thing this is.
    const indexText = [
      `${KIND_LABEL[c.kind] || c.kind} — ${c.list || ''}`,
      where,
      // A document's folder often names what it's about ("Upgrade vFebruary2026").
      c.meta?.folder ? `Folder: ${c.meta.folder}` : null,
      c.text,
      ...facets(c.meta),
    ].filter(Boolean).join('\n');
    return {
      ...c,
      docUrl: c.sourceType === 'list-item' ? (c.meta?.documentUrl || c.links?.[0]?.url || null) : null,
      indexText,
    };
  });
}
