// Ranking over the bundled corpus. No dependencies and no DOM, so the same
// code runs in the side panel and under node (see tools/test-search.mjs).

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'get', 'has', 'have', 'how', 'i', 'if', 'in', 'is',
  'it', 'its', 'me', 'my', 'need', 'of', 'on', 'or', 'our', 'should', 'so',
  'that', 'the', 'their', 'there', 'this', 'to', 'up', 'use', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

/**
 * Fold obvious plurals so "students" matches "Student".
 * Deliberately conservative — only -ies and a trailing -s.
 */
function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/**
 * Title and body are indexed separately: a term in the title is a much
 * stronger signal than the same term buried in prose, and folding both into
 * one frequency loses that.
 */
export function buildIndex(corpus) {
  const df = new Map();

  const docs = corpus.map((c) => {
    const title = tokenize(c.t);
    const body = tokenize(c.x);
    const facet = tokenize([c.l, c.c, (c.r || []).join(' ')].filter(Boolean).join(' '));

    const count = (terms) => {
      const m = new Map();
      for (const t of terms) m.set(t, (m.get(t) || 0) + 1);
      return m;
    };

    for (const t of new Set([...title, ...body, ...facet])) {
      df.set(t, (df.get(t) || 0) + 1);
    }

    return { title: count(title), body: count(body), facet: count(facet), len: body.length || 1 };
  });

  return { corpus, docs, df };
}

/**
 * Rank chunks against a query, strongest first.
 *
 * Returns [] rather than a weak guess when the query isn't covered — for a
 * grounded assistant, "not on this site" beats a confident bad citation.
 */
export function search(index, query, limit = 4) {
  const { corpus, docs, df } = index;
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const N = corpus.length;
  const needle = query.toLowerCase().trim();

  // Short queries must be fully covered; longer ones need half their terms.
  // Without this, one incidental word ("file" in "how do I file my taxes")
  // is enough to surface an unrelated chunk.
  const minCover = terms.length <= 2 ? 1 : 0.5;

  const idf = (t) => {
    const n = df.get(t) || 0;
    return n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0;
  };

  const scored = [];

  for (let i = 0; i < corpus.length; i++) {
    if (corpus[i].h) continue;                     // hidden on the live site

    const d = docs[i];
    let title = 0, body = 0, facet = 0, matched = 0;

    for (const term of terms) {
      const tt = d.title.get(term) || 0;
      const tb = d.body.get(term) || 0;
      const tf = d.facet.get(term) || 0;
      if (!tt && !tb && !tf) continue;
      matched++;

      const w = idf(term);
      if (tt) title += w * (1 + Math.log(tt));
      if (tb) body += w * (tb / (tb + 1.2));
      if (tf) facet += w * 0.6;
    }

    if (matched / terms.length < minCover) continue;

    // A title hit dominates: it means the chunk is *about* the term.
    let score = title * 2.4 + body + facet;
    score *= 0.6 + 0.4 * (matched / terms.length);

    // Whole query appearing verbatim in the title is as good as it gets.
    if (corpus[i].t.toLowerCase().includes(needle)) score *= 1.8;

    if (score > 0) scored.push({ chunk: corpus[i], score });
  }

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < 1.2) return [];
  return scored.filter((s) => s.score >= top.score * 0.35).slice(0, limit);
}
