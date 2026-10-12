// Every bullet and numbered step in an answer carries a citation.
//
// The prompt asks for it, but the model sometimes cites only the lead-in
// sentence ("The Thrive objectives cover this [1]:") and leaves the bullets
// under it bare. After the answer is written, each uncited item gets the
// excerpt it overlaps most with, preferring the ones the lead-in cited.

const ITEM = /^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/;
const CITE = /\[\d+(?:\s*,\s*\d+)*\]/;
const STOP = new Set('a an and are as at be by can do does for from has have how i if in into is it its of on or so that the their them then there these they this to up use using was what when where which who will with you your yours'.split(' '));

const words = (s) => new Set(String(s).toLowerCase().replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ').match(/[a-z0-9]{3,}/g)?.map((w) => w.replace(/(?:ies|es|s)$/, '')).filter((w) => !STOP.has(w)) || []);

/** Share of the item's content words that appear in the excerpt. */
function overlap(itemWords, excerptWords) {
  if (!itemWords.size) return 0;
  let hit = 0;
  for (const w of itemWords) if (excerptWords.has(w)) hit++;
  return hit / itemWords.size;
}

const citedIn = (s) => [...s.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim())));

/** Bullets and steps without a citation (questions back to the person don't count). */
export function uncitedItems(answer) {
  return String(answer).split('\n')
    .map((l) => ITEM.exec(l))
    .filter((m) => m && m[2].trim() && !CITE.test(m[2]) && !/\?\s*$/.test(m[2]))
    .map((m) => m[2].trim());
}

/**
 * @param {string} answer
 * @param {{text: string, title?: string}[]} excerpts  in citation order: excerpts[0] is [1]
 * @returns {{ text: string, added: number, unresolved: string[] }}
 */
export function repairCitations(answer, excerpts, { min = 0.3, leadMin = 0.15 } = {}) {
  const ex = excerpts.map((c) => words(`${c.title || ''} ${c.text || ''}`));
  let lead = [];          // what the sentence introducing the current list cited
  let added = 0;
  const unresolved = [];
  const lines = String(answer).split('\n').map((line) => {
    const m = ITEM.exec(line);
    if (!m) {
      if (line.trim()) lead = citedIn(line).filter((n) => ex[n - 1]);
      return line;
    }
    const body = m[2];
    if (!body.trim() || CITE.test(body) || /\?\s*$/.test(body)) return line;
    const w = words(body);
    let best = 0, bestScore = 0;
    ex.forEach((e, i) => {
      const s = overlap(w, e) + (lead.includes(i + 1) ? 0.1 : 0);
      if (s > bestScore) { best = i + 1; bestScore = s; }
    });
    let n = bestScore >= min ? best : 0;
    if (!n && lead.length) n = [...lead].sort((a, b) => overlap(w, ex[b - 1]) - overlap(w, ex[a - 1]))[0];
    if (n && !lead.includes(n) && overlap(w, ex[n - 1]) < leadMin) n = 0;
    if (!n) { unresolved.push(body.trim()); return line; }
    added++;
    // Before trailing punctuation, like the model writes them: "… easy to find [8]."
    const [, text, punct] = /^(.*?)([.;:,]?)\s*$/.exec(body);
    return `${m[1]}${text} [${n}]${punct}`;
  });
  return { text: lines.join('\n'), added, unresolved };
}
