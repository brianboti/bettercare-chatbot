// Render a streamed answer as DOM, safely. Shared by the side panel and the
// site replica (served at /lib/render.js).
//
// Supports the small Markdown subset the prompt asks the model to use:
// paragraphs, "- " / "1. " lists, **bold**, `code`, [n] citations, and bare
// URLs. Everything is built with createElement/textContent — model output is
// never passed to innerHTML.

import { splitCitations } from './chat-api.js';

/**
 * @param {string} text        answer so far (re-render on every token)
 * @param {(n:number) => Node|null} cite  builds the node for citation [n]
 * @returns {DocumentFragment}
 */
export function renderAnswer(text, cite) {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r/g, '').split('\n');

  let list = null;      // current <ul>/<ol>
  let para = null;      // current <p> lines

  const flushPara = () => {
    if (para) { frag.append(inlineBlock('p', para.join(' '), cite)); para = null; }
  };
  const flushList = () => { if (list) { frag.append(list); list = null; } };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);

    if (!line) { flushPara(); flushList(); continue; }

    if (heading) {
      flushPara(); flushList();
      frag.append(inlineBlock('h4', heading[1], cite));
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); }
      list.append(inlineBlock('li', bullet ? bullet[1] : numbered[2], cite));
    } else {
      flushList();
      (para ||= []).push(line);
    }
  }
  flushPara(); flushList();
  return frag;
}

function inlineBlock(tag, text, cite) {
  const node = document.createElement(tag);
  appendInline(node, text, cite);
  return node;
}

/** **bold**, `code`, [n] citations, and URLs within one block of text. */
function appendInline(parent, text, cite) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)\]]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) appendCites(parent, text.slice(last, m.index), cite);
    const tok = m[0];
    if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      appendCites(b, tok.slice(2, -2), cite);
      parent.append(b);
    } else if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      parent.append(c);
    } else {
      const a = document.createElement('a');
      a.href = tok; a.textContent = tok; a.target = '_blank'; a.rel = 'noopener';
      parent.append(a);
    }
    last = re.lastIndex;
  }
  if (last < text.length) appendCites(parent, text.slice(last), cite);
}

function appendCites(parent, text, cite) {
  for (const part of splitCitations(text)) {
    if (part.text != null) parent.append(document.createTextNode(part.text));
    else parent.append(cite(part.cite) || document.createTextNode(`[${part.cite}]`));
  }
}
