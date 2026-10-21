// The one place that reads process.env. Every tunable lives here once.
//
// Load a .env file with:  node --env-file-if-exists=.env server/index.mjs

import { fileURLToPath } from 'node:url';

const env = process.env;
const fromRoot = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

const int = (key, dflt) => {
  const v = env[key];
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: ${key} must be a number, got "${v}"`);
  return n;
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const config = Object.freeze({
  SITE_NAME: env.SITE_NAME || 'BetterCare',
  SITE_URL: env.SITE_URL || 'https://uthealthsa.sharepoint.com/sites/BetterCare',

  PORT: int('PORT', 8787),
  // On Google Cloud (Cloud Run, GKE, App Engine) listen on every interface
  // so the platform can reach the server; on a laptop, only this machine.
  HOST: env.HOST || (env.K_SERVICE || env.KUBERNETES_SERVICE_HOST || env.GAE_SERVICE ? '0.0.0.0' : '127.0.0.1'),

  // Credentials are resolved by the SDK (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
  // or an `ant auth login` profile). With none, the server runs retrieval-only.
  LLM_ENABLED: env.LLM_DISABLED !== '1',
  ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || 'claude-opus-5',
  // The search rewrite is a small classify-and-rephrase job; it can run on a
  // cheaper model than the answer. Defaults to the answer model.
  REWRITE_MODEL: env.REWRITE_MODEL || env.ANTHROPIC_MODEL || 'claude-opus-5',
  ANTHROPIC_EFFORT: (() => {
    const e = env.ANTHROPIC_EFFORT || 'low';
    if (!EFFORTS.includes(e)) throw new Error(`config: ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')}`);
    return e;
  })(),
  MAX_TOKENS: int('MAX_TOKENS', 8192),

  // Backup provider: when Claude can't be reached (no credit, bad key,
  // outage), the same job runs on OpenAI. Needs OPENAI_API_KEY. LLM_PRIMARY
  // =openai makes OpenAI answer first (to test it, or if Claude is gone).
  OPENAI_MODEL: env.OPENAI_MODEL || 'gpt-5.5',
  OPENAI_QUICK_MODEL: env.OPENAI_QUICK_MODEL || 'gpt-5.4-mini',
  BACKUP_ENABLED: env.BACKUP_DISABLED !== '1',
  LLM_PRIMARY: env.LLM_PRIMARY === 'openai' ? 'openai' : 'claude',
  // Server-side refusal fallback (Claude API only). Set to 0 on Bedrock/Vertex/Foundry.
  REFUSAL_FALLBACK: env.REFUSAL_FALLBACK !== '0',

  // EMBEDDING_MODEL and EMBEDDING_DIMS are one unit: the cache is keyed on the
  // model id and rebuilt when it changes, so they can't drift apart silently.
  EMBEDDING_MODEL: env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5',
  EMBEDDING_QUERY_PREFIX: env.EMBEDDING_QUERY_PREFIX ?? 'Represent this sentence for searching relevant passages: ',

  RETRIEVAL_CANDIDATES: int('RETRIEVAL_CANDIDATES', 40),
  RETRIEVAL_TOP_K: int('RETRIEVAL_TOP_K', 8),
  MAX_PER_SOURCE: int('MAX_PER_SOURCE', 3),
  // Broad questions ("what's new for surgeons in the last upgrade") need a
  // whole deck's worth of context, not eight scattered passages.
  BROAD_TOP_K: int('BROAD_TOP_K', 16),
  BROAD_MAX_PER_SOURCE: int('BROAD_MAX_PER_SOURCE', 8),
  // Cosine similarity of the best semantic match below which we tell the model
  // retrieval is weak. Tuned against tools/eval-retrieval.mjs.
  LOW_CONFIDENCE_THRESHOLD: Number(env.LOW_CONFIDENCE_THRESHOLD || 0.69),

  // Sources dated more than this many days before the newest match are
  // "older": listed last, under "Older results" in the pane.
  RECENT_WINDOW_DAYS: int('RECENT_WINDOW_DAYS', 365),

  // ------------------------------------------------------------ data files
  // Where the search index and the site export live. Each can point outside
  // the repository (a mounted volume or bucket); the defaults are under data/.
  CHUNKS_FILE: env.CHUNKS_FILE || fromRoot('data/index/chunks.json'),
  // Vector cache for the chunks. Built by `npm run build:index` (the Docker
  // build runs it); the server only writes it when the chunks changed.
  EMBEDDINGS_FILE: env.EMBEDDINGS_FILE || fromRoot('data/embeddings.json'),
  // Where the embedding model is downloaded and read from (transformers.js
  // cache). Empty: the library's default, inside node_modules.
  MODEL_CACHE_DIR: env.MODEL_CACHE_DIR || '',
  // The BetterCare site export served as the website (pages, snapshots,
  // lists, files). Optional: without it the API and the extension still work.
  SITE_DIR: env.SITE_DIR || fromRoot('data/site'),
  // Saved results of the admin panel's Tests tab.
  TEST_RESULTS_DIR: env.TEST_RESULTS_DIR || fromRoot('data/eval'),
  // Per-turn diagnostics (JSON lines). "-" writes them to standard output
  // (Cloud Logging on GCP), "off" turns them off. Tests point it at a temp file.
  CHAT_LOG: env.CHAT_LOG || fromRoot('data/logs/chat.jsonl'),

  // ------------------------------------------------------------ database
  // Users, question history, feedback, pushed content, sign-in sessions.
  //   sqlite     one file (SOPHIA_DB); for a laptop and the tests
  //   firestore  Google Cloud Firestore; credentials come from the service
  //              account on GCP (or `gcloud auth application-default login`)
  DATABASE: (() => {
    const d = (env.DATABASE || 'sqlite').toLowerCase();
    if (!['sqlite', 'firestore'].includes(d)) throw new Error('config: DATABASE must be sqlite or firestore');
    return d;
  })(),
  DB_FILE: env.SOPHIA_DB || fromRoot('data/sophia.db'),
  // Empty project: the one the service account belongs to (automatic on GCP).
  FIRESTORE_PROJECT_ID: env.FIRESTORE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',
  FIRESTORE_DATABASE_ID: env.FIRESTORE_DATABASE_ID || '(default)',
  // Put in front of every collection name, so two deployments (demo, staging)
  // can share one database.
  FIRESTORE_COLLECTION_PREFIX: env.FIRESTORE_COLLECTION_PREFIX || '',

  // ------------------------------------------------------------ sign-in
  //   password  username and password accounts stored in the database (the
  //             demo sign-in). Everything but /api/health and the sign-in
  //             page needs a signed-in person.
  //   header    trust the X-Sophia-User header, no sign-in. Local
  //             development and the tests only: anyone can be anyone.
  // Microsoft (Entra ID) sign-in will be a third mode; see server/auth.mjs.
  AUTH_MODE: (() => {
    const m = (env.AUTH_MODE || 'password').toLowerCase();
    if (!['password', 'header'].includes(m)) throw new Error('config: AUTH_MODE must be password or header');
    return m;
  })(),
  SESSION_DAYS: int('SESSION_DAYS', 7),
  // Let people create their own account on the sign-in page.
  ALLOW_SIGNUP: env.ALLOW_SIGNUP === '1',
  // The extension may sign people in as whoever SharePoint says is signed in
  // there. Not verified by the server: for demos only, until Microsoft
  // sign-in is set up.
  SHAREPOINT_SIGNIN: env.SHAREPOINT_SIGNIN === '1',
  SHAREPOINT_EMAIL_DOMAINS: list(env.SHAREPOINT_EMAIL_DOMAINS ?? 'uthscsa.edu,uthealthsa.org'),
  // Created (or its password reset) at startup, as an admin. Optional.
  ADMIN_USERNAME: (env.ADMIN_USERNAME || '').trim().toLowerCase(),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  // These people are admins whenever they sign in (usernames or emails).
  ADMIN_USERS: list(env.ADMIN_USERS),
  // Cookies get the Secure flag when the request came over HTTPS; "1" forces it.
  COOKIE_SECURE: env.COOKIE_SECURE === '1',

  MAX_HISTORY_TURNS: int('MAX_HISTORY_TURNS', 10),
  MAX_QUESTION_CHARS: int('MAX_QUESTION_CHARS', 2000),
  RATE_LIMIT_MESSAGES: int('RATE_LIMIT_MESSAGES', 30),
  RATE_LIMIT_WINDOW_MIN: int('RATE_LIMIT_WINDOW_MIN', 10),
});
