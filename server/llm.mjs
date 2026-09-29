// Claude calls: query rewrite and streamed answers.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { SYSTEM, REWRITE_SYSTEM, rewriteSchema } from './prompt.mjs';
import { TOPIC_NAMES, cleanTopics } from './topics.mjs';

let client = null;

/** True when an API credential is available and the LLM isn't disabled. */
export function llmAvailable() {
  if (!config.LLM_ENABLED) return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function anthropic() {
  client ||= new Anthropic();
  return client;
}

/** Server-side refusal fallback (Claude API): a declined request is re-run on another model. */
const fallback = () => (config.REFUSAL_FALLBACK
  ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
  : {});

/**
 * Rewrite the latest message into a standalone, vocabulary-expanded search
 * query, and classify it (topics for personalization and analytics, intent
 * for answer length).
 * @returns {Promise<{ query: string, topics: string[], intent: string|null }>}
 */
export async function rewriteQuery(history, latest, facts = '', person = '') {
  const transcript = history.length
    ? history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`).join('\n')
    : '(no earlier messages)';
  const res = await anthropic().beta.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: rewriteSchema(TOPIC_NAMES) } },
    ...fallback(),
    system: REWRITE_SYSTEM,
    messages: [{ role: 'user', content: `${facts ? `<site_facts>\n${facts}\n</site_facts>\n\n` : ''}${person ? `<person>\n${person}\n</person>\n\n` : ''}<conversation>\n${transcript}\n</conversation>\n\nLatest message: ${latest}` }],
  });
  const fallbackResult = { query: latest, topics: [], intent: null };
  if (res.stop_reason === 'refusal') return fallbackResult;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  try {
    const out = JSON.parse(text);
    return { query: String(out.query || latest).split('\n')[0].slice(0, 500), topics: cleanTopics(out.topics), intent: out.intent || null };
  } catch {
    return fallbackResult;
  }
}

/**
 * One short structured call: Claude writes the welcome line and phrases the
 * suggestion cards in Sophia's voice. `schema` constrains the output.
 */
export async function generateJson(system, content, schema, { maxTokens = 1500 } = {}) {
  const res = await anthropic().beta.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    ...fallback(),
    system,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason !== 'end_turn') return null;
  try { return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')); } catch { return null; }
}

/**
 * Stream an answer. Calls onText for each text delta, and onReset if the
 * model declined mid-stream and a fallback model took over (the partial text
 * so far should be discarded).
 * @returns {Promise<{ stopReason: string, model: string, usage: object }>}
 */
export async function streamAnswer(messages, { onText, onReset }, signal) {
  const stream = anthropic().beta.messages.stream({
    model: config.ANTHROPIC_MODEL,
    max_tokens: config.MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.ANTHROPIC_EFFORT },
    ...fallback(),
    // The system prompt is identical on every request; cache it.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  }, { signal });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
    else if (event.type === 'content_block_start' && event.content_block.type === 'fallback') onReset?.();
  }
  const final = await stream.finalMessage();
  return { stopReason: final.stop_reason, model: final.model, usage: final.usage, stopDetails: final.stop_details };
}

export { Anthropic };
