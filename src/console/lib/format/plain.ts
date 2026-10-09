// Markdown to the words of a one-line preview (a thread row, a pinned
// message): the marks are taken off, not rendered — a heading loses its
// "#", a link keeps its text, a fence keeps its code, emphasis keeps the
// words. The first line with words is the preview; the caller clips it.
// Not a parser: the common marks of what agents and people write, each a
// small rule, so a stray "*" or "_" in a sentence stays as it is.

const INLINE: [RegExp, string][] = [
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'], // ![alt](src) → alt
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'], // [text](href) → text
  [/\[([^\]]+)\]\[[^\]]*\]/g, '$1'], // [text][ref] → text
  [/<(https?:\/\/[^\s>]+)>/g, '$1'], // <https://…> → https://…
  [/`+([^`]+)`+/g, '$1'], // `code` → code
  [/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2'], // **bold** / __bold__
  [/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1$2'], // *em*
  [/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1$2'], // _em_
  [/~~(?=\S)(.+?)(?<=\S)~~/g, '$1'], // ~~strike~~
  [/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1'], // \* → *
];

const LINE_START = /^(?:\s*>)*\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?)?/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function plainInline(line: string): string {
  return INLINE.reduce((text, [mark, words]) => text.replace(mark, words), line);
}

// One line of Markdown as words; '' for a line that is only marks.
function plainOfLine(line: string): string {
  if (RULE.test(line) || TABLE_DIVIDER.test(line)) {
    return '';
  }

  const body = line.replace(LINE_START, '');
  const cells = body.includes('|') ? body.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|') : [body];

  return cells
    .map(cell => plainInline(cell).trim())
    .filter(Boolean)
    .join(' · ');
}

// The first line of Markdown that has words, as plain text.
export function plainLine(markdown: string): string {
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      continue;
    }

    const words = plainOfLine(line);

    if (words) {
      return words;
    }
  }

  return '';
}
