// What an LLM call cost, from its usage block. First-party Claude API and
// OpenAI API list prices in USD per million tokens (checked 2026-10-09);
// Bedrock and Vertex bill differently. Estimates for the dashboard, not an
// invoice. OpenAI has no cache-write charge, so its write columns repeat input.

const PRICES = {
  //                      input  output  5m write  1h write  cache read
  'claude-fable-5-1':   [10,    50,     12.5,     20,       0.25],
  'claude-fable-5':     [10,    50,     12.5,     20,       1],
  'claude-opus-5-5':    [4,     20,     5,        8,        0.2],
  'claude-opus-5':      [5,     25,     6.25,     10,       0.5],
  'claude-opus-4-8':    [5,     25,     6.25,     10,       0.5],
  'claude-opus-4-7':    [5,     25,     6.25,     10,       0.5],
  'claude-opus-4-6':    [5,     25,     6.25,     10,       0.5],
  'claude-sonnet-5-5':  [2,     10,     2.5,      4,        0.2],
  'claude-sonnet-5':    [2,     10,     2.5,      4,        0.2],
  'claude-sonnet-4-6':  [3,     15,     3.75,     6,        0.3],
  'claude-haiku-4-5':   [1,     5,      1.25,     2,        0.1],
  'gpt-5.5':            [5,     30,     5,        5,        0.5],
  'gpt-5.4':            [2.5,   15,     2.5,      2.5,      0.25],
  'gpt-5.4-mini':       [0.75,  4.5,    0.75,     0.75,     0.075],
  'gpt-5.4-nano':       [0.2,   1.25,   0.2,      0.2,      0.02],
  'gpt-5-mini':         [0.25,  2,      0.25,     0.25,     0.025],
};

/** Price row for a model id, tolerating date suffixes and platform prefixes. */
export function priceFor(model) {
  const id = String(model || '').replace(/^(us\.|eu\.|global\.)?anthropic\./, '').replace(/[@-]\d{8}$|-\d{4}-\d{2}-\d{2}$/, '');
  return PRICES[id] || null;
}

/** Token counts of one usage block (or one usage.iterations entry). */
export function tokensOf(u = {}) {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    write1h,
  };
}

function costOne(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  const t = tokensOf(u);
  return (t.input * p[0] + t.output * p[1] + (t.cacheWrite - t.write1h) * p[2] + t.write1h * p[3] + t.cacheRead * p[4]) / 1e6;
}

/**
 * Cost of a response. With refusal fallbacks, usage.iterations lists every
 * attempt (top-level usage covers only the last), each billed at the rates
 * of the model that ran it.
 * @returns {{ cost: number|null, tokens: object }}  cost is null for an unpriced model
 */
export function costOfResponse(model, usage = {}) {
  const parts = Array.isArray(usage.iterations) && usage.iterations.length
    ? usage.iterations.map((it) => ({ model: it.model || model, usage: it }))
    : [{ model, usage }];
  let cost = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const p of parts) {
    const c = costOne(p.model, p.usage);
    cost = cost == null || c == null ? null : cost + c;
    const t = tokensOf(p.usage);
    for (const k of Object.keys(tokens)) tokens[k] += t[k];
  }
  return { cost, tokens };
}
