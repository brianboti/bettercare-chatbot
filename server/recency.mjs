// Newest first. Sources are ordered by date, and anything much older than the
// newest match is marked `older` so the pane can tuck it under "Older results"
// and the model can treat it as background.

/** The date that says how current a source is: its event/publish date, else when the file or page last changed. */
export const sourceDate = (c) => c.meta?.date || c.meta?.published || c.meta?.modified || null;

/**
 * @param {object[]} results  retrieved chunks, best match first
 * @param {{ windowDays: number, today?: string }} opts
 * @returns {{ results: object[], older: Set<string>, cutoff: string|null }}
 *   results reordered: recent dated (newest first), then undated (in match
 *   order), then older (newest first). Undated sources (contacts, glossary)
 *   are never "older".
 */
export function orderByRecency(results, { windowDays, today = new Date().toISOString().slice(0, 10) }) {
  const dated = results.filter((c) => sourceDate(c));
  if (!dated.length) return { results, older: new Set(), cutoff: null };
  // Measure from the newest match, but not from a future event date: an event
  // next spring shouldn't make this year's content look old.
  const newest = dated.map(sourceDate).sort().pop();
  const anchor = newest > today ? today : newest;
  const cutoff = new Date(Date.parse(`${anchor}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);

  const byDateDesc = (a, b) => sourceDate(b).localeCompare(sourceDate(a));
  const recent = dated.filter((c) => sourceDate(c) >= cutoff).sort(byDateDesc);
  const old = dated.filter((c) => sourceDate(c) < cutoff).sort(byDateDesc);
  const undated = results.filter((c) => !sourceDate(c));
  return { results: [...recent, ...undated, ...old], older: new Set(old.map((c) => c.id)), cutoff };
}
