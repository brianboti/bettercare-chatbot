// Claude calls: query rewrite and streamed answers.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { SYSTEM, REWRITE_SYSTEM, rewriteSchema } from './prompt.mjs';
import { TOPIC_NAMES, cleanTopics } from './topics.mjs';

let client = null;

// Where each call's usage goes (the store, for the spend dashboard). Set once
// by the server; tools that import this module record nothing.
let usageSink = null;
export function onUsage(fn) { usageSink = fn; }
function report(purpose, res, meta = {}) {
  try { usageSink?.({ purpose, model: res.model, usage: res.usage, userId: meta.userId ?? null }); } catch (e) { console.warn('could not record usage:', e.message); }
}

/** True when an API credential is available and the LLM isn't disabled. */
export function llmAvailable() {
  if (!config.LLM_ENABLED) return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function anthropic() {
  client ||= new Anthropic();
  return client;
}

/**
 * Server-side refusal fallback (Claude API): a declined request is re-run on
 * another model. Only models with refusal classifiers take it (not Haiku 4.5).
 */
const fallback = (model) => (config.REFUSAL_FALLBACK && /opus-5|sonnet-5-5|fable-5/.test(model)
  ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
  : {});

/**
 * Short structured calls (rewrite, welcome): no thinking, least effort. Each
 * model spells that differently: Opus 5.5 and Fable can't turn thinking off
 * (low effort instead), Sonnet 5.5 uses between_tools, Haiku 4.5 has no effort.
 */
function quick(model, format) {
  if (/haiku-4-5/.test(model)) return { thinking: { type: 'disabled' }, output_config: { format } };
  if (/sonnet-5-5/.test(model)) return { thinking: { type: 'between_tools' }, output_config: { effort: 'low', format } };
  if (/opus-5-5|fable-5/.test(model)) return { output_config: { effort: 'low', format } };
  return { thinking: { type: 'disabled' }, output_config: { effort: 'low', format } };
}

/**
 * Rewrite the latest message into a standalone, vocabulary-expanded search
 * query, and classify it (topics for personalization and analytics, intent
 * for answer length).
 * @returns {Promise<{ query: string, topics: string[], intent: string|null }>}
 */
export async function rewriteQuery(history, latest, facts = '', person = '', meta = {}) {
  const transcript = history.length
    ? history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`).join('\n')
    : '(no earlier messages)';
  const model = meta.model || config.REWRITE_MODEL;
  const res = await anthropic().beta.messages.create({
    model,
    max_tokens: 1024,
    ...quick(model, { type: 'json_schema', schema: rewriteSchema(TOPIC_NAMES) }),
    ...fallback(model),
    system: REWRITE_SYSTEM,
    messages: [{ role: 'user', content: `${facts ? `<site_facts>\n${facts}\n</site_facts>\n\n` : ''}${person ? `<person>\n${person}\n</person>\n\n` : ''}<conversation>\n${transcript}\n</conversation>\n\nLatest message: ${latest}` }],
  });
  report('rewrite', res, meta);
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
export async function generateJson(system, content, schema, { maxTokens = 1500, purpose = 'other', userId = null, model = config.ANTHROPIC_MODEL } = {}) {
  const res = await anthropic().beta.messages.create({
    model,
    max_tokens: maxTokens,
    ...quick(model, { type: 'json_schema', schema }),
    ...fallback(model),
    system,
    messages: [{ role: 'user', content }],
  });
  report(purpose, res, { userId });
  if (res.stop_reason !== 'end_turn') return null;
  try { return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')); } catch { return null; }
}

/**
 * Stream an answer. Calls onText for each text delta, and onReset if the
 * model declined mid-stream and a fallback model took over (the partial text
 * so far should be discarded).
 * @returns {Promise<{ stopReason: string, model: string, usage: object }>}
 */
export async function streamAnswer(messages, { onText, onReset }, signal, meta = {}) {
  const model = meta.model || config.ANTHROPIC_MODEL;
  const stream = anthropic().beta.messages.stream({
    model,
    max_tokens: config.MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.ANTHROPIC_EFFORT },
    ...fallback(model),
    // The system prompt is identical on every request; cache it.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  }, { signal });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
    else if (event.type === 'content_block_start' && event.content_block.type === 'fallback') onReset?.();
  }
  const final = await stream.finalMessage();
  report('answer', final, meta);
  return { stopReason: final.stop_reason, model: final.model, usage: final.usage, stopDetails: final.stop_details };
}

export { Anthropic };
