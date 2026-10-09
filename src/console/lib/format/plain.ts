// Markdown to the words of a one-line preview (a thread row, a pinned
// message): the marks are taken off, not rendered — a heading loses its
// "#", a link keeps its text, a fence keeps its code, emphasis keeps the
// words. The first line with words is the preview; the caller clips it.
// Not a parser: the common marks of what agents and people write, each a
// small rule, so a stray "*" or "_" in a sentence stays as it is. What
// Markdown shows literally stays literal: the code of a code span, of a
// fence or of an indented block, an escaped mark, a URL — they are held
// aside before the marks come off and put back after, so a mark inside
// them is never read as a mark and the words of one rule never become the
// marks of the next.

const HELD = /\0(\d+)\0/g;

// Code spans (CommonMark: a run of backticks is closed by a run of the same
// length; one space is stripped from both ends when both have one) and
// escapes, in one pass left to right, so an escaped backtick never opens a
// code span.
const LITERAL = /\\([\\`*_{}[\]()#+\-.!>~|])|(?<!`)(`+)(?!`)(.+?)(?<!`)\2(?!`)/g;
const AUTOLINK = /<(https?:\/\/[^\s>]+)>|https?:\/\/[^\s<>]+/g;

// The destination of a link or an image: "(href)" with one level of
// balanced parentheses in the href, or "<href>", then an optional title in
// quotes or parentheses.
const DEST = String.raw`\(\s*(?:<[^<>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)`;
const LINKS: [RegExp, string][] = [
  [new RegExp(String.raw`!\[([^\]]*)\]${DEST}`, 'g'), '$1'], // ![alt](src) → alt
  [new RegExp(String.raw`\[([^\]]+)\]${DEST}`, 'g'), '$1'], // [text](href) → text
  [/!?\[([^\]]+)\]\[[^\]]*\]/g, '$1'], // [text][ref], ![alt][ref] → text
];
const EMPHASIS: [RegExp, string][] = [
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1'], // **bold**
  [/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1$2'], // __bold__, not a__b__c
  [/(^|[^\p{L}\p{N}*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1$2'], // *em*
  [/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1$2'], // _em_
  [/~~(?=\S)(.+?)(?<=\S)~~/g, '$1'], // ~~strike~~
];

const QUOTE = /^(?:\s*>)*\s*/;
const LINE_START = /^(?:\s*>)*\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?)?/;
const HEADING = /^(?:\s*>)*\s*#{1,6}\s/;
const HEADING_CLOSE = /\s+#+\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// The literal parts of a line held aside as "\0<n>\0" (a message never
// has a NUL), to be put back by release(); pick names the literal among
// the match's groups.
function hold(line: string, pattern: RegExp, held: string[], pick: (groups: string[]) => string): string {
  return line.replace(pattern, (...groups: string[]) => {
    held.push(pick(groups));

    return `\0${held.length - 1}\0`;
  });
}

// The code of a code span: one space off both ends when both have one.
const codeOf = (code: string): string => (code.startsWith(' ') && code.endsWith(' ') && code.trim() ? code.slice(1, -1) : code);
const literalOf = (groups: string[]): string => groups[1] ?? codeOf(groups[3]!);
const urlOf = (groups: string[]): string => groups[1] ?? groups[0]!;

function release(text: string, held: string[]): string {
  return text.replace(HELD, (_, index: string) => held[Number(index)]!);
}

const strip = (text: string, rules: [RegExp, string][]): string => rules.reduce((words, [mark, kept]) => words.replace(mark, kept), text);

// The words of one line of Markdown — or of its table cells, joined by
// " · " — with the marks off; '' for a line that is only marks.
function plainOfLine(line: string, row: boolean): string {
  const held: string[] = [];
  const marked = hold(line.replace(LINE_START, ''), LITERAL, held, literalOf);
  const body = HEADING.test(line) ? marked.replace(HEADING_CLOSE, '') : marked;
  const cells = row ? body.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|') : [body];

  return cells
    .map(cell => release(strip(hold(strip(cell, LINKS), AUTOLINK, held, urlOf), EMPHASIS), held).trim())
    .filter(Boolean)
    .join(' · ');
}

// The first line of Markdown that has words, as plain text.
export function plainLine(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: string | null = null; // the opening marks while inside a fence
  let table = false; // the line before was a table's divider or row

  for (const [i, line] of lines.entries()) {
    if (fence) {
      if (line.trim().startsWith(fence)) {
        fence = null;
      } else if (line.trim()) {
        return line.trim(); // a fence keeps its code as it is
      }
      continue;
    }

    const opening = FENCE.exec(line);

    if (opening) {
      fence = opening[1]!;
      continue;
    }
    if (!line.trim()) {
      table = false;
      continue;
    }
    if (RULE.test(line) || TABLE_DIVIDER.test(line)) {
      table = line.includes('|');
      continue;
    }
    if (INDENTED.test(line) && !table) {
      return line.trim(); // an indented code block keeps its code as it is
    }

    const next = lines[i + 1] ?? '';
    const row = line.replace(QUOTE, '').includes('|') && (table || (TABLE_DIVIDER.test(next) && next.includes('|')));
    const words = plainOfLine(line, row);

    table = row;
    if (words) {
      return words;
    }
  }

  return '';
}
