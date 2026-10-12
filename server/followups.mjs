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

// The answer opens with the assumptions Sophia is making, one per line, each
// with how the person would correct it:
//
//   <assumptions>
//   You're documenting with ProcDoc in Epic | I'm not using ProcDoc
//   You don't have NoteWriter macros yet | I already have macros
//   </assumptions>
//
// Like the suggestions block, it is cut out of the streamed text and sent as
// its own event; the client shows it as an "Assuming" line above the answer.

const A_OPEN = '<assumptions';
const A_CLOSE = '</assumptions>';

export class AssumptionSplitter {
  /** @param {(a: {text: string, fix: string|null}[]) => void} onAssumptions */
  constructor(onAssumptions) { this.buf = ''; this.state = 'start'; this.onAssumptions = onAssumptions; }

  /** Feed a text delta; returns the part that belongs to the answer. */
  push(text) {
    if (this.state === 'pass') return text;
    this.buf += text;
    if (this.state === 'start') {
      const lead = this.buf.trimStart();
      if (!lead) return '';
      if (lead.length < A_OPEN.length && A_OPEN.startsWith(lead)) return '';   // could still be the tag
      if (!lead.startsWith(A_OPEN)) return this.release();
      this.state = 'block';
    }
    const end = this.buf.indexOf(A_CLOSE);
    if (end < 0) return '';
    this.onAssumptions?.(parseAssumptions(this.buf.slice(0, end + A_CLOSE.length)));
    const rest = this.buf.slice(end + A_CLOSE.length).replace(/^\s+/, '');
    this.buf = '';
    this.state = 'pass';
    return rest;
  }

  /** End of stream: anything still held back (an unclosed block is dropped). */
  finish() {
    if (this.state === 'block') { this.onAssumptions?.(parseAssumptions(this.buf)); this.buf = ''; return ''; }
    return this.release();
  }

  release() { const out = this.buf; this.buf = ''; this.state = 'pass'; return out; }
}

export function parseAssumptions(block) {
  const m = /<assumptions\s*>([\s\S]*?)(?:<\/assumptions>|$)/.exec(block || '');
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [text, fix] = l.split('|').map((s) => s.trim().replace(/^"|"$/g, ''));
      return { text: text.slice(0, 120), fix: fix ? fix.slice(0, 80) : null };
    })
    .filter((a) => a.text)
    .slice(0, 3);
}
