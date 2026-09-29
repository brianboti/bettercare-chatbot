// The answer ends with a machine-readable block of quick replies or follow-up
// questions:
//
//   <suggestions kind="reply">
//   It says "device not registered"
//   I haven't tried anything yet
//   </suggestions>
//
// kind="reply"    Sophia asked the person something; these are likely answers
// kind="followup" natural next questions after a complete answer
//
// The block is cut out of the streamed text so it never flashes on screen,
// and sent to the client as its own event.

const OPEN = '<suggestions';

export class SuggestionSplitter {
  constructor() { this.buf = ''; this.inBlock = false; this.block = ''; }

  /** Feed a text delta; returns the part that is safe to show now. */
  push(text) {
    if (this.inBlock) { this.block += text; return ''; }
    this.buf += text;
    const at = this.buf.indexOf(OPEN);
    if (at >= 0) {
      const out = this.buf.slice(0, at);
      this.block = this.buf.slice(at);
      this.buf = '';
      this.inBlock = true;
      return out;
    }
    // Hold back a trailing fragment that could be the start of the tag.
    let keep = 0;
    for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) {
      if (OPEN.startsWith(this.buf.slice(-n))) { keep = n; break; }
    }
    const out = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return out;
  }

  /** End of stream: any held-back text, and the parsed block (or null). */
  finish() {
    const rest = this.buf;
    this.buf = '';
    return { text: rest, suggestions: parseSuggestions(this.block) };
  }
}

export function parseSuggestions(block) {
  const m = /<suggestions(?:\s+kind="(reply|followup)")?\s*>([\s\S]*?)(?:<\/suggestions>|$)/.exec(block || '');
  if (!m) return null;
  const items = m[2].split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^"|"$/g, '').trim())
    .filter((l) => l && l.length <= 120)
    .slice(0, 4);
  return items.length ? { kind: m[1] || 'followup', items } : null;
}
