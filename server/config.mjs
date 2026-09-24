// The one place that reads process.env. Every tunable lives here once.
//
// Load a .env file with:  node --env-file-if-exists=.env server/index.mjs

const env = process.env;

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
  HOST: env.HOST || '127.0.0.1',

  // Credentials are resolved by the SDK (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
  // or an `ant auth login` profile). With none, the server runs retrieval-only.
  LLM_ENABLED: env.LLM_DISABLED !== '1',
  ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || 'claude-opus-5',
  ANTHROPIC_EFFORT: (() => {
    const e = env.ANTHROPIC_EFFORT || 'low';
    if (!EFFORTS.includes(e)) throw new Error(`config: ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')}`);
    return e;
  })(),
  MAX_TOKENS: int('MAX_TOKENS', 8192),
  // Server-side refusal fallback (Claude API only). Set to 0 on Bedrock/Vertex/Foundry.
  REFUSAL_FALLBACK: env.REFUSAL_FALLBACK !== '0',

  // EMBEDDING_MODEL and EMBEDDING_DIMS are one unit: the cache is keyed on the
  // model id and rebuilt when it changes, so they can't drift apart silently.
  EMBEDDING_MODEL: env.EMBEDDING_MODEL || 'Xenova/bge-small-en-v1.5',
  EMBEDDING_QUERY_PREFIX: env.EMBEDDING_QUERY_PREFIX ?? 'Represent this sentence for searching relevant passages: ',

  RETRIEVAL_CANDIDATES: int('RETRIEVAL_CANDIDATES', 40),
  RETRIEVAL_TOP_K: int('RETRIEVAL_TOP_K', 8),
  MAX_PER_SOURCE: int('MAX_PER_SOURCE', 3),
  // Cosine similarity of the best semantic match below which we tell the model
  // retrieval is weak. Tuned against tools/eval-retrieval.mjs.
  LOW_CONFIDENCE_THRESHOLD: Number(env.LOW_CONFIDENCE_THRESHOLD || 0.69),

  MAX_HISTORY_TURNS: int('MAX_HISTORY_TURNS', 10),
  MAX_QUESTION_CHARS: int('MAX_QUESTION_CHARS', 2000),
  RATE_LIMIT_MESSAGES: int('RATE_LIMIT_MESSAGES', 30),
  RATE_LIMIT_WINDOW_MIN: int('RATE_LIMIT_WINDOW_MIN', 10),
});
