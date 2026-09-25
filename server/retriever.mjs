// Hybrid retrieval: BM25 keyword ranking + embedding similarity, fused with
// Reciprocal Rank Fusion.
//
// Keyword search finds exact names ("SlicerDicer", "vAugust2024") that
// embeddings blur; embeddings find meaning ("Epic on my phone" → Haiku) that
// keywords miss. Each result records which retriever found it, so bad
// retrieval can be diagnosed from the data rather than by guessing.

import { config } from './config.mjs';
import { embedChunks, embedQuery } from './embedder.mjs';
import { buildFacts } from './facts.mjs';

// ---------------------------------------------------------------- keyword

const STOP = new Set(('a an and are as at be but by can could did do does for from get got has have how i if in into is it '
  + 'its me my need of on or our should so that the their them then there these this those to up was we were what '
  + 'when where which who whom why will with would you your about any some tell find show').split(' '));

/** Light suffix folding — enough that "upgrades" matches "upgrade". */
function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokenize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Everyday words -> the site's Epic vocabulary, for keyword search. (The LLM
// rewrite does this more cleverly for chat; this keeps search-as-you-type,
// which has no LLM in the loop, from missing the obvious ones.)
const SYNONYMS = {
  phone: ['haiku', 'mobile'], iphone: ['haiku'], android: ['haiku'], mobile: ['haiku'],
  ipad: ['canto'], tablet: ['canto'],
  lab: ['beaker'], dental: ['wisdom'], dentist: ['wisdom'], dentistry: ['wisdom'],
  scribe: ['abridge', 'ambient'], ambient: ['abridge'], dictation: ['abridge'],
  inbox: ['basket', 'inbasket'], ticket: ['teamdynamix', 'help', 'desk'],
  downtime: ['bca', 'continuity'], report: ['slicerdicer', 'reporting'], dashboard: ['cogito', 'slicerdicer'],
  training: ['thrive'], class: ['training'], upgrade: ['refuel'],
  surgeon: ['surgical', 'optime', 'surgery', 'procedure'], surgery: ['surgical', 'optime', 'procedure'],
  nurse: ['nursing'], anesthesiologist: ['anesthesia'], pharmacist: ['willow', 'pharmacy'],
};

/** Query terms with weights: the user's own words 1, added synonyms 0.35. */
function expand(terms) {
  const out = new Map(terms.map((t) => [t, 1]));
  for (const t of terms) for (const s of SYNONYMS[t] || []) if (!out.has(stem(s))) out.set(stem(s), 0.35);
  return [...out];
}

class BM25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = docs.map((tokens) => {
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return { tf, len: tokens.length || 1 };
    });
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }
  idf(t) {
    const n = this.df.get(t) || 0, N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }
  /** @param {[term: string, weight: number][]} terms */
  score(i, terms) {
    const d = this.docs[i];
    let s = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += w * this.idf(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / this.avg));
    }
    return s;
  }
}

// ---------------------------------------------------------------- index

export async function buildRetriever(chunks, opts = {}) {
  const titleIdx = new BM25(chunks.map((c) => tokenize([c.title, ...(c.headingPath || [])].join(' '))));
  const bodyIdx = new BM25(chunks.map((c) => tokenize(c.indexText)));
  const vectors = await embedChunks(chunks, opts);
  const vecs = chunks.map((c) => vectors.get(c.id));
  const facts = buildFacts(chunks);
  const cos = (a, b) => { let d = 0; for (let j = 0; j < a.length; j++) d += a[j] * b[j]; return d; };

  function keyword(query, n) {
    const terms = expand([...new Set(tokenize(query))]);
    if (!terms.length) return [];
    const scored = [];
    for (let i = 0; i < chunks.length; i++) {
      // A title hit means the chunk is *about* the term.
      const s = 2 * titleIdx.score(i, terms) + bodyIdx.score(i, terms);
      if (s > 0) scored.push({ i, s });
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, n);
  }

  async function vector(query, n) {
    const q = await embedQuery(query);
    const scored = vecs.map((v, i) => {
      let dot = 0;
      for (let j = 0; j < v.length; j++) dot += v[j] * q[j];
      return { i, s: dot };
    });
    return scored.sort((a, b) => b.s - a.s).slice(0, n);
  }

  /**
   * @returns {{ results: RetrievedChunk[], confidence: number, lowConfidence: boolean }}
   *   confidence is the best cosine similarity among the returned results.
   */
  async function retrieve(query, {
    topK = config.RETRIEVAL_TOP_K,
    candidates = config.RETRIEVAL_CANDIDATES,
    maxPerSource = config.MAX_PER_SOURCE,
  } = {}) {
    // Several phrasings of one question (the user's words + an expanded
    // rewrite) are each searched both ways, and all lists are fused. "The last
    // upgrade" is resolved to its version first (see facts.mjs).
    const queries = [...new Set([].concat(query).map((q) => facts.expand(q.trim())).filter(Boolean))];
    const lists = await Promise.all(queries.map(async (q) => ({ kw: keyword(q, candidates), vec: await vector(q, candidates) })));

    // RRF: score = Σ 1 / (k + rank). k=60 is the standard constant.
    const K = 60;
    const fused = new Map();
    const bump = (list, name) => list.forEach(({ i, s }, rank) => {
      const e = fused.get(i) || { i, rrf: 0, retrievedBy: [], cos: null, bm25: null };
      e.rrf += 1 / (K + rank + 1);
      if (!e.retrievedBy.includes(name)) e.retrievedBy.push(name);
      if (name === 'vector') e.cos = Math.max(e.cos ?? -1, s); else e.bm25 = Math.max(e.bm25 ?? 0, s);
      fused.set(i, e);
    });
    for (const { kw, vec } of lists) { bump(vec, 'vector'); bump(kw, 'keyword'); }
    const vec = lists.flatMap((l) => l.vec).sort((a, b) => b.s - a.s);

    // Keyword-only hits still need a cosine for the confidence signal.
    const cosOf = new Map();
    for (const { i, s } of vec) if (!cosOf.has(i)) cosOf.set(i, s);   // vec is sorted, so first = best

    // Diversify, so near-copies don't crowd out other sources:
    //  - at most maxPerSource chunks per title (a deck saved as both PDF and
    //    PowerPoint shares one budget), and 2 per title for list rows (a
    //    class repeated on eight calendar dates)
    //  - no page/document chunk nearly identical to one already chosen
    const perTitle = new Map();
    const top = [];
    for (const e of [...fused.values()].sort((a, b) => b.rrf - a.rrf)) {
      const c = chunks[e.i];
      const key = `${c.sourceType === 'list-item' ? 'L' : 'D'}:${c.title.toLowerCase().replace(/\W+/g, ' ').trim()}`;
      const n = perTitle.get(key) || 0;
      if (n >= (c.sourceType === 'list-item' ? 2 : maxPerSource)) continue;
      if (c.sourceType !== 'list-item' && top.some((t) => cos(vecs[t.i], vecs[e.i]) > 0.97)) continue;
      perTitle.set(key, n + 1);
      top.push(e);
      if (top.length >= topK) break;
    }

    const results = top.map((e) => ({
      ...chunks[e.i],
      score: +e.rrf.toFixed(5),
      cosine: e.cos ?? cosOf.get(e.i) ?? null,
      bm25: e.bm25 != null ? +e.bm25.toFixed(3) : null,
      retrievedBy: e.retrievedBy,
    }));

    const confidence = vec[0]?.s ?? 0;
    return { results, confidence, lowConfidence: confidence < config.LOW_CONFIDENCE_THRESHOLD };
  }

  return { retrieve, facts, size: chunks.length };
}
