// Minimal HTML -> plain text for SharePoint rich-text fields.
// SharePoint double-encodes: entities like &#58; survive inside style attributes,
// and every block is wrapped in <div class="ExternalClass...">.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', bull: '\u2022',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/**
 * @returns {{ text: string, links: {text: string, url: string}[] }}
 */
export function htmlToText(html) {
  if (!html) return { text: '', links: [] };

  // SharePoint encodes entities inside the markup itself, so decode before parsing.
  let s = decodeEntities(String(html));

  const links = [];
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, inner) => {
    const label = stripTags(inner).trim();
    if (url && !url.startsWith('#')) links.push({ text: label, url });
    return label || url;
  });

  s = s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/\s*t[dh]\s*>/gi, '\t');

  return { text: normalize(stripTags(s)), links };
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

export function normalize(s) {
  return String(s)
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')  // zero-width junk from the rich-text editor
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
