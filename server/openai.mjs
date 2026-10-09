// OpenAI: the backup provider. The same three jobs as Claude (search rewrite,
// welcome cards, streamed answers), through the Responses API, used when
// Claude can't be reached (see withBackup in llm.mjs). Same prompts; usage is
// reported in Claude's shape so the spend panel prices it the same way.

import OpenAI from 'openai';
import { config } from './config.mjs';

let client = null;
const openai = () => (client ||= new OpenAI());

export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY);

/** OpenAI usage -> the fields pricing.mjs reads (OpenAI counts cached tokens inside input_tokens). */
export function usageOf(u = {}) {
  const cached = u.input_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: (u.input_tokens || 0) - cached,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: u.output_tokens || 0,
  };
}

/** One structured call; returns { json, model, usage } (json is null if it didn't parse or was refused). */
export async function openaiJson(system, content, schema, { model = config.OPENAI_QUICK_MODEL, name = 'result' } = {}) {
  const res = await openai().responses.create({
    model,
    instructions: system,
    input: [{ role: 'user', content }],
    reasoning: { effort: 'low' },
    max_output_tokens: 4000,
    text: { format: { type: 'json_schema', name, schema, strict: true } },
  });
  let json = null;
  if (res.status === 'completed') { try { json = JSON.parse(res.output_text); } catch { /* null */ } }
  return { json, model: res.model, usage: usageOf(res.usage) };
}

/**
 * Stream an answer. Same contract as streamAnswer in llm.mjs.
 * @returns {Promise<{ stopReason: string, model: string, usage: object }>}
 */
export async function openaiStream(system, messages, { onText }, signal, { model = config.OPENAI_MODEL } = {}) {
  const stream = await openai().responses.create({
    model,
    instructions: system,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    reasoning: { effort: config.ANTHROPIC_EFFORT === 'low' ? 'low' : 'medium' },
    max_output_tokens: config.MAX_TOKENS,
    stream: true,
  }, { signal });
  let final = null, refused = false;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') onText(event.delta);
    else if (event.type === 'response.refusal.delta') refused = true;
    else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
    else if (event.type === 'response.failed' || event.type === 'error') throw new Error(`OpenAI: ${event.response?.error?.message || event.message || 'response failed'}`);
  }
  if (!final) throw new Error('OpenAI: stream ended without a response');
  return {
    stopReason: refused ? 'refusal' : final.status === 'incomplete' ? 'max_tokens' : 'end_turn',
    model: final.model,
    usage: usageOf(final.usage),
  };
}

export { OpenAI };
