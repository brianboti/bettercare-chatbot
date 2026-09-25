// Time-aware facts derived from the corpus, so "the last upgrade" or "the
// next upgrade" resolve to a specific Epic version before searching.
//
// Epic versions are written several ways across the site: "vFebruary2026"
// on pages, "vFeb2026" in the timeline list, "vFeb26" in file names.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const VERSION = /\bv(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s?(\d{4}|\d{2})\b/i;

/** All spellings of an Epic version: vFeb2026 -> [vFebruary2026, vFeb2026, vFeb26]. */
export function versionForms(v) {
  const m = VERSION.exec(v);
  if (!m) return [v];
  const month = MONTHS.find((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  const year = m[2].length === 2 ? `20${m[2]}` : m[2];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return [...new Set([`v${cap(month)}${year}`, `v${cap(month.slice(0, 3))}${year}`, `v${cap(month.slice(0, 3))}${year.slice(2)}`])];
}

/**
 * @param {object[]} chunks  the corpus
 * @returns {{ upgrades: {version, date}[], context(today?): object, expand(query, today?): string }}
 */
export function buildFacts(chunks) {
  // The "Upgrade Timeline" list is the site's authoritative go-live schedule.
  const upgrades = chunks
    .filter((c) => c.list === 'Upgrade Timeline' && c.meta?.date && VERSION.test(c.title))
    .map((c) => ({ version: versionForms(c.title)[0], date: c.meta.date }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // The site is in San Antonio; "today" is Central time, not UTC.
  const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  function context(today = new Date()) {
    const t = iso(today);
    const past = upgrades.filter((u) => u.date <= t);
    const future = upgrades.filter((u) => u.date > t);
    return { today: t, last: past[past.length - 1] || null, previous: past[past.length - 2] || null, next: future[0] || null, upgrades };
  }

  /**
   * Append the concrete version (all spellings) when a query refers to an
   * upgrade relatively, and all spellings of any version it names.
   */
  function expand(query, today = new Date()) {
    const ctx = context(today);
    const add = new Set();
    const q = query.toLowerCase();
    const aboutUpgrade = /\b(upgrade|release|version|go-?live|update)\b/.test(q);
    if (aboutUpgrade && /\b(last|latest|most recent|recent|current|newest|this)\b/.test(q) && ctx.last) versionForms(ctx.last.version).forEach((v) => add.add(v));
    if (aboutUpgrade && /\b(previous|prior|before that)\b/.test(q) && ctx.previous) versionForms(ctx.previous.version).forEach((v) => add.add(v));
    if (aboutUpgrade && /\b(next|upcoming|coming|future)\b/.test(q) && ctx.next) versionForms(ctx.next.version).forEach((v) => add.add(v));
    for (const m of query.matchAll(new RegExp(VERSION, 'gi'))) versionForms(m[0]).forEach((v) => add.add(v));
    for (const v of versionForms(query)) if (query.includes(v)) add.delete(v);
    return add.size ? `${query} ${[...add].join(' ')}` : query;
  }

  /** One paragraph of schedule facts for prompts. */
  function describe(today = new Date()) {
    const ctx = context(today);
    const fmt = (u) => `${u.version} (also written ${versionForms(u.version).slice(1).join(', ')}), go-live ${u.date}`;
    return [
      `Epic upgrade schedule from the site's Upgrade Timeline (today is ${ctx.today}):`,
      ctx.last && `- Most recent upgrade already live: ${fmt(ctx.last)}`,
      ctx.previous && `- The one before it: ${fmt(ctx.previous)}`,
      ctx.next && `- Next upgrade: ${fmt(ctx.next)}`,
    ].filter(Boolean).join('\n');
  }

  return { upgrades, context, expand, describe };
}
