#!/usr/bin/env node
// Seed demo people, pushed content and a month of question history, so the
// personalized welcome and the insights dashboard have something to show.
//
//   npm run seed:demo            replace existing demo data
//   npm run seed:demo -- --clear remove demo data only
//
// Every row written here has demo=1; real usage is never touched. Answers are
// the retrieval-only kind (no Claude calls, no cost): real search results
// for real questions, so confidence scores and sources are genuine.

import { openStore } from '../server/store.mjs';
import { config } from '../server/config.mjs';
import { loadChunks } from '../server/corpus.mjs';
import { buildRetriever } from '../server/retriever.mjs';
import { sourceView, extractiveAnswer } from '../server/chat.mjs';
import { tagTopics } from '../server/topics.mjs';

const store = openStore(config.DB_FILE);
store.clearDemo();
if (process.argv.includes('--clear')) { console.log('demo data removed'); process.exit(0); }

// Deterministic pseudo-random, so every seed produces the same demo.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];

// ---------------------------------------------------------------- people

// The people the replica's "signed in as" switcher offers.
const PEOPLE = [
  { id: 'maria.lopez', name: 'Dr. Maria Lopez', role: 'surgeon', department: 'Surgery' },
  { id: 'james.okafor', name: 'Dr. James Okafor', role: 'physician', department: 'Family & Community Medicine' },
  { id: 'jamie.chen', name: 'Jamie Chen', role: 'nurse', department: 'Inpatient Medicine' },
  { id: 'alex.rivera', name: 'Alex Rivera', role: 'frontdesk', department: 'Family Medicine Clinic' },
  { id: 'sam.nguyen', name: 'Dr. Sam Nguyen', role: 'dental', department: 'School of Dentistry' },
  { id: 'taylor.brooks', name: 'Taylor Brooks', role: 'it', department: 'Clinical IT', isAdmin: true },
];

// What people in each role ask. The last few per role are things the site
// doesn't cover well, so the dashboard's "trouble" list is realistic.
const QUESTIONS = {
  surgeon: [
    'What changed for surgeons in the last upgrade?', 'How do I use Abridge in clinic?', 'When is the next Epic Thrive for surgeons?',
    'How do I get access to Abridge?', 'What is new in OpTime?', 'How do I pin the Abridge tab in Epic?',
    'Can a resident and an attending both record with Abridge?', 'What changed for anesthesia in the latest upgrade?',
    'How do I request OR block time?', 'Where do I find my surgical case volume report?',
  ],
  physician: [
    "How do I cover someone else's In Basket?", 'How do I get access to Abridge?', 'Which dot phrase gives an Abridge patient visit summary?',
    'How do I set up Haiku on my phone?', 'What is Qualified Chat?', 'Is there an AI governance policy?', 'When is the next Epic upgrade?',
    'What is Charge Capture Navigator?', 'How do I turn off In Basket notifications at night?', 'Can Abridge write my referral letters?',
  ],
  nurse: [
    'When is the next Epic upgrade?', 'What training do nurses need for the upgrade?', 'Where is the downtime BCA policy for MSRH?',
    'How do I set up Epic on an iPad?', 'Who do I call for Epic help?', 'What is Epic Thrive training?',
    "How do I cover someone else's In Basket?", 'How do I document a blood transfusion in Epic?', 'Where is the flowsheet for wound care?',
  ],
  frontdesk: [
    'Where is the cash drawer tip sheet?', 'How do I schedule a follow-up appointment in Cadence?', 'Who do I call for Epic help?',
    'What is Charge Capture Navigator?', 'How do I check in a patient in Prelude?', 'Phone number for the Mays Cancer Center lab draw station',
    'How do I print a patient receipt?', 'How do I merge duplicate patient records?',
  ],
  dental: [
    'What is SlicerDicer called in axiUm?', 'What training do dental students need?', 'Where are the Wisdom tip sheets?',
    'When is the next Epic Thrive for Dentistry?', 'How do I chart a periodontal exam in Wisdom?', 'How do I bill a dental insurance claim?',
  ],
  it: [
    'Did UT Health reach Epic Gold Stars level 7?', 'Is there an AI governance policy?', 'What is Qualified Health?',
    'When is the next Epic upgrade?', 'What changed in Refuel Phase 4?', 'Where are the analytics dashboards?',
  ],
  pharmacy: ['What changed for pharmacy in the last upgrade?', 'Who do I call for Epic help?', 'How do I verify an order in Willow?'],
  lab: ['Phone number for the Mays Cancer Center lab draw station', 'Where are the Beaker tip sheets?', 'How do I relabel a specimen in Beaker?'],
};

// Background colleagues, so "other nurses are asking…" has other nurses.
const PEERS = [];
for (const [role, n] of Object.entries({ surgeon: 6, physician: 9, nurse: 12, frontdesk: 7, dental: 5, it: 3, pharmacy: 3, lab: 3 })) {
  for (let i = 1; i <= n; i++) PEERS.push({ id: `peer-${role}-${i}`, name: null, role, department: null });
}

const daysAgo = (d, h = 9) => {
  const t = new Date(Date.now() - d * 86_400_000);
  t.setUTCHours(13 + h % 10, Math.floor(rand() * 60), Math.floor(rand() * 60));
  return t.toISOString();
};

// ---------------------------------------------------------------- run

console.log('loading corpus…');
const chunks = loadChunks();
const retriever = await buildRetriever(chunks);

for (const p of [...PEOPLE, ...PEERS]) store.saveUser(p.id, { ...p, demo: true, createdAt: daysAgo(40) });

const answers = new Map();
async function answer(q) {
  if (!answers.has(q)) {
    const r = await retriever.retrieve(q);
    answers.set(q, { ...r, sources: r.results.map((c, i) => sourceView(c, i + 1)), text: extractiveAnswer(r.results, r.lowConfidence) });
  }
  return answers.get(q);
}

let turns = 0;
async function ask(user, q, at, conv, { feedback } = {}) {
  const a = await answer(q);
  const id = store.addTurn({
    userId: user.id, conversationId: conv, at, question: q, rewritten: q, intent: null, topics: tagTopics(q),
    answer: a.text, sources: a.sources, confidence: a.confidence, lowConfidence: a.lowConfidence, mode: 'retrieval-only',
    latencyMs: 2500 + Math.floor(rand() * 4000), demo: true,
  });
  turns++;
  // Most good answers get a source opened; weak ones rarely do.
  if (!a.lowConfidence && rand() < 0.6 && a.sources[0]) {
    const s = rand() < 0.75 ? a.sources[0] : pick(a.sources.slice(0, 3));
    store.addEvent({ userId: user.id, at, type: 'citation_click', turnId: id, ref: s.id, data: { title: s.title, kind: s.kind, url: s.url }, demo: true });
  }
  const fb = feedback ?? (a.lowConfidence ? (rand() < 0.45 ? -1 : null) : rand() < 0.25 ? 1 : rand() < 0.04 ? -1 : null);
  if (fb) store.setFeedback(id, user.id, fb, fb < 0 && a.lowConfidence ? pick(["Didn't find what I needed", 'Not on the site?', 'Wrong answer']) : null);
  return id;
}

// Colleagues: 30 days of questions, weekday-heavy.
for (let d = 30; d >= 1; d--) {
  const weekday = new Date(Date.now() - d * 86_400_000).getUTCDay() % 6 !== 0;
  const n = Math.floor((weekday ? 9 : 2) + rand() * 6);
  for (let i = 0; i < n; i++) {
    const u = pick(PEERS);
    const q = pick(QUESTIONS[u.role]);
    const conv = `demo-${u.id}-${d}-${i}`;
    await ask(u, q, daysAgo(d, i), conv);
    // Now and then the same person rephrases right away.
    if (rand() < 0.08) await ask(u, `${q.replace(/\?$/, '')} please`, new Date(Date.parse(daysAgo(d, i)) + 60_000).toISOString(), conv);
  }
}

// The listed people's own history, so the welcome can build on it.
const OWN = {
  'maria.lopez': [[12, 'How do I get access to Abridge?'], [12, 'Can a resident and an attending both record with Abridge?'], [5, 'How do I pin the Abridge tab in Epic?']],
  'james.okafor': [[9, "How do I cover someone else's In Basket?"], [3, 'Which dot phrase gives an Abridge patient visit summary?']],
  'jamie.chen': [[15, 'Where is the downtime BCA policy for MSRH?'], [6, 'How do I set up Epic on an iPad?']],
  'alex.rivera': [[7, 'Where is the cash drawer tip sheet?']],
  'sam.nguyen': [[10, 'What is SlicerDicer called in axiUm?']],
  'taylor.brooks': [[4, 'Did UT Health reach Epic Gold Stars level 7?']],
};
for (const [id, list] of Object.entries(OWN)) {
  const u = PEOPLE.find((p) => p.id === id);
  for (const [d, q] of list) await ask(u, q, daysAgo(d), `demo-${id}-${d}`, { feedback: 1 });
}

// What Clinical IT wants people to see.
const PROMOS = [
  {
    title: "Dr. Sankary on Becker's Health IT podcast",
    blurb: 'Our CMIO talks about AI and digital health at UT Health San Antonio.',
    prompt: "Summarize Dr. Sankary's appearance on the Becker's Healthcare Digital Health + Health IT podcast.",
    roles: [], priority: 5,
  },
  {
    title: 'Epic Thrive for Surgeons, October 14',
    blurb: 'Hands-on session before the vMay2026 upgrade.',
    prompt: 'When is the next Epic Thrive for surgeons and how do I sign up?',
    roles: ['surgeon'], priority: 8,
  },
  {
    title: 'Get ready for the vMay2026 upgrade',
    blurb: 'Goes live November 11. See what changes for your area.',
    prompt: 'What is changing in the vMay2026 upgrade and when does it go live?',
    roles: ['nurse', 'physician', 'frontdesk', 'pharmacy', 'lab', 'it'], priority: 6,
  },
];
const promoIds = PROMOS.map((p) => store.savePromotion({ ...p, demo: true }, 'taylor.brooks').id);
// Some history of promotions being shown and clicked.
for (const u of PEERS) {
  for (const [i, pid] of promoIds.entries()) {
    const p = PROMOS[i];
    if (p.roles.length && !p.roles.includes(u.role)) continue;
    if (rand() < 0.7) store.addEvent({ userId: u.id, at: daysAgo(Math.floor(rand() * 10) + 1), type: 'promo_shown', ref: String(pid), demo: true });
    if (rand() < 0.22) store.addEvent({ userId: u.id, at: daysAgo(Math.floor(rand() * 10) + 1), type: 'promo_click', ref: String(pid), demo: true });
  }
}

console.log(`seeded ${PEOPLE.length} people + ${PEERS.length} colleagues, ${turns} questions, ${PROMOS.length} promotions → ${config.DB_FILE}`);
store.close();
