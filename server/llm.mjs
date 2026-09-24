// Claude calls: query rewrite and streamed answers.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { SYSTEM, REWRITE_SYSTEM } from './prompt.mjs';

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
 * query, using the conversation when there is one.
 */
export async function rewriteQuery(history, latest) {
  const transcript = history.length
    ? history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`).join('\n')
    : '(no earlier messages)';
  const res = await anthropic().beta.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    ...fallback(),
    system: REWRITE_SYSTEM,
    messages: [{ role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\nLatest message: ${latest}` }],
  });
  if (res.stop_reason === 'refusal') return latest;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return text.split('\n')[0].slice(0, 500) || latest;
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
