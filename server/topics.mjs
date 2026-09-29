// The topics questions are grouped by, for personalization and the admin
// dashboard. One controlled list, so "Abridge" from the rewrite model and
// "Abridge" from the keyword tagger count as the same thing.
//
// The rewrite model assigns topics when Claude is available; tagTopics() is
// the fallback (no API key, seeded demo data, a failed rewrite call).

export const TOPICS = {
  'Abridge': /\b(abridge|ambient|scribe|dictat)/i,
  'Haiku & Canto': /\b(haiku|canto|iphone|android|ipad|tablet|mobile|rover|on (my|a|your) phone)\b/i,
  'Epic upgrades': /\b(upgrade|refuel|v(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\d{2,4}|go-?live|release)\b/i,
  'Training': /\b(training|class|course|thrive|e-?learning|register for|enroll)\b/i,
  'Surgery & OpTime': /\b(surg|optime|operating room|procedure|anesthes)/i,
  'In Basket': /\b(in ?basket|inbox|messages?)\b/i,
  'Scheduling & registration': /\b(cadence|schedul|appointment|front desk|registration|prelude|check-?in)/i,
  'Lab (Beaker)': /\b(beaker|lab\b|labs\b|specimen)/i,
  'Dental (Wisdom)': /\b(wisdom|dental|dentist|axium)/i,
  'Pharmacy (Willow)': /\b(willow|pharmac|medication|prescri)/i,
  'Nursing': /\b(nurs|flowsheet|mar\b|charting)/i,
  'Billing & charges': /\b(charge|billing|coding|cash drawer|payment|claim)/i,
  'Reporting & analytics': /\b(report|slicerdicer|dashboard|cogito|analytics|metric)/i,
  'Generative AI': /\b(ai\b|artificial intelligence|genai|generative|copilot|chatgpt|qualified|llm)\b/i,
  'Access & help desk': /\b(access|password|log ?in|help desk|ticket|teamdynamix|contact|call|support|broken|error|not working)\b/i,
  'Downtime': /\b(downtime|bca|business continuity|outage)\b/i,
};

export const TOPIC_NAMES = Object.keys(TOPICS);

/** Keyword topic tagger: up to `max` topics, most specific first. */
export function tagTopics(text, max = 2) {
  const hits = TOPIC_NAMES.filter((t) => TOPICS[t].test(text));
  // "Access & help desk" matches almost any troubleshooting question; keep it
  // only when nothing more specific did.
  const specific = hits.filter((t) => t !== 'Access & help desk');
  return (specific.length ? specific : hits).slice(0, max);
}

/** Keep only names from the controlled list (model output is untrusted). */
export const cleanTopics = (topics) => [...new Set((topics || []).filter((t) => TOPIC_NAMES.includes(t)))].slice(0, 3);

// Roles a person picks at first run. `apps` seeds which Epic applications
// matter to them; the rewrite and suggestions use it.
export const ROLES = {
  physician: { label: 'Physician / APP', topics: ['Abridge', 'In Basket', 'Epic upgrades', 'Haiku & Canto'] },
  surgeon: { label: 'Surgeon / anesthesia', topics: ['Surgery & OpTime', 'Epic upgrades', 'Abridge'] },
  nurse: { label: 'Nurse', topics: ['Nursing', 'Training', 'Epic upgrades'] },
  frontdesk: { label: 'Front desk & scheduling', topics: ['Scheduling & registration', 'Billing & charges', 'Training'] },
  pharmacy: { label: 'Pharmacy', topics: ['Pharmacy (Willow)', 'Epic upgrades'] },
  lab: { label: 'Lab', topics: ['Lab (Beaker)', 'Epic upgrades'] },
  dental: { label: 'Dental', topics: ['Dental (Wisdom)', 'Training'] },
  it: { label: 'Clinical IT / analyst', topics: ['Epic upgrades', 'Reporting & analytics', 'Generative AI'] },
  other: { label: 'Something else', topics: ['Training', 'Access & help desk'] },
};

export const roleLabel = (r) => ROLES[r]?.label || null;
