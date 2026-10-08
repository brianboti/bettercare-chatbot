// Spot content the site admin made to try something out ("Wisdom-TEST",
// "mary-test", "test234", "TESTANALYTICS") without dropping content that uses
// the word "test" for real ("Add Tests to an Existing Specimen", "Rapid Retest",
// "Fungus Testing Laboratory", "Nation's Fastest Supercomputer").
//
// The rule works on names (page file names, document file and folder names,
// list titles, row titles), split into words:
//   - "test" on its own is a marker, unless the name also has a word that
//     makes it a real test (lab, specimen, COVID, results…).
//   - "test" glued to other letters is a marker ("Testq", "TESTANALYTICS",
//     "BCATESTLOOKUP"), unless the whole word is an ordinary English word
//     ("tests", "testing", "testimonials", "latest", "fastest", "retest").
// Anything this gets wrong goes in KEEP (or, for a whole list, its rule in
// src/lists.config.mjs).

/** Names that look like test content but are real. Matched exactly, case-insensitive. */
export const KEEP = new Set([
  // e.g. 'Test Results Tip Sheet.pdf',
].map((s) => s.toLowerCase()));

// Real words that contain "test".
const REAL_WORD = /^(tests|test(ed|er|ers|ing|ings|imony|imonial|imonials|ament|aments|ify|ified|ifies|osterone|icular|icle|icles|is)|(pre|post|re)test(s|ed|ing)?|(con|pro|at|de)test\w*|intestin\w*)$/;

// Words that, next to "test", mean a real test rather than a trial run.
const REAL_CONTEXT = /\b(labs?|laborator(y|ies)|specimens?|samples?|blood|urine|covid|influenza|flu|strep|pregnancy|drugs?|screen(ing|ings)?|results?|resulting|orders?|ordering|panels?|assays?|glucose|cultures?|diagnostics?|patients?|point[- ]of[- ]care|poc|hearing|vision|skills?|competency|knowledge|exams?|quiz(zes)?|tb|hiv|hepatitis|genetic|beaker|stress|allergy|sensitivity)\b/i;

/** Split a name into words: separators, camelCase, and letter/digit boundaries. */
export function words(name) {
  return String(name)
    .replace(/\.[a-z0-9]{2,5}$/i, '')                 // file extension
    .replace(/([a-z])([A-Z])/g, '$1 $2')             // maryTest -> mary Test
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')       // BCTest -> BC Test
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')             // test234 -> test 234
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * Is this name a test/trial item? Returns the word that gave it away, or null.
 * @param {string} name
 */
export function testMarker(name) {
  if (!name || KEEP.has(String(name).toLowerCase())) return null;
  for (const w of words(name)) {
    const l = w.toLowerCase();
    if (!l.includes('test')) continue;
    if (l !== 'test' && l.endsWith('test')) continue;     // latest, fastest, retest, contest
    if (REAL_WORD.test(l)) continue;
    if (l === 'test' && REAL_CONTEXT.test(String(name).replace(/[_-]+/g, ' '))) continue;
    return w;
  }
  return null;
}

/** Body text that is only a placeholder ("test", "testing 123", lorem ipsum). */
export function placeholderText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/lorem ipsum/i.test(t)) return true;
  return t.length < 60 && /^(this is (a|just a) )?(test(ing)?\b[\s\d.!,-]*)+$/i.test(t);
}

/** The first name in `names` that marks test content, as "<name>" ("<word>"), or null. */
export function testReason(...names) {
  for (const n of names.flat()) {
    const w = testMarker(n);
    if (w) return `test content: "${n}"`;
  }
  return null;
}
