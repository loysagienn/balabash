// Agent Markdown → Telegram rich messages (Bot API sendRichMessage with the
// `markdown` field). Telegram parses the Markdown itself — GFM-compatible:
// tables, headings, lists, checkboxes, code, quotes, footnotes — so the text
// travels as written, with two corrections where Telegram's reading differs
// from what the agent meant (both checked on a live send, 2026-10-13):
//   - `<` outside code is a literal character, not a tag: rich Markdown takes
//     arbitrary HTML and silently drops the tags it does not know, so
//     `Array<string>` would arrive as `Array`. It goes as `&lt;`;
//   - a single line break inside a paragraph is a line break, not a space
//     (CommonMark joins the lines): it gets a hard break (two trailing
//     spaces).
// A table wider than Telegram's 20 columns goes as a code block, and a text
// over the rich message limits is split at top-level block boundaries.

import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';

// sendMessage's limit, for the plain-text messages that still use it.
export const TELEGRAM_MESSAGE_LIMIT = 4096;

// Rich message limits (core.telegram.org/bots/api#rich-message-limits):
// 32768 characters of message text, 500 blocks, 20 table columns. The text
// is measured here by its Markdown source, which is never shorter than the
// parsed text; the margins absorb what Telegram itself adds (footnote
// labels) and the blocks this count cannot see the way Telegram does.
export const RICH_MESSAGE_MAX_CHARS = 32000;
export const RICH_MESSAGE_MAX_BLOCKS = 480;
export const RICH_TABLE_MAX_COLUMNS = 20;

export type RichLimits = { maxChars: number; maxBlocks: number };

const DEFAULT_LIMITS: RichLimits = { maxChars: RICH_MESSAGE_MAX_CHARS, maxBlocks: RICH_MESSAGE_MAX_BLOCKS };

// The parser only finds the structure (code, paragraphs, tables, block
// boundaries); nothing is rendered.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

function parse(source: string): Token[] {
  return markdown.parse(source, {});
}

// Block tokens Telegram counts against the 500-block limit (nested blocks,
// list items, table rows, quotations).
const COUNTED_BLOCKS = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'table_open',
  'tr_open',
  'fence',
  'code_block',
  'hr',
  'html_block',
]);

// --- preparation -----------------------------------------------------------

// `<scheme:…>` and `<user@host>` are Markdown autolinks, not tags.
const AUTOLINK_RE = /^<(?:[a-z][a-z\d+.-]{1,31}:[^\s<>]*|[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*)>/i;

// Which characters of `text` sit inside inline code spans (a backtick run
// closed by a run of the same length; an unmatched run is literal).
function inlineCodeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const runs: { start: number; length: number }[] = [];

  for (let index = 0; index < text.length; ) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }

    let end = index;

    while (text[end] === '`') {
      end += 1;
    }

    // A backslash-escaped backtick opens nothing.
    let backslashes = 0;

    for (let back = index - 1; back >= 0 && text[back] === '\\'; back -= 1) {
      backslashes += 1;
    }

    runs.push({ start: backslashes % 2 === 1 ? index + 1 : index, length: end - index - (backslashes % 2) });
    index = end;
  }

  for (let open = 0; open < runs.length; open += 1) {
    const opener = runs[open];

    if (!opener || opener.length === 0) {
      continue;
    }

    const closeIndex = runs.findIndex((run, index) => index > open && run.length === opener.length);
    const closer = runs[closeIndex];

    if (!closer) {
      continue;
    }

    for (let index = opener.start; index < closer.start + closer.length; index += 1) {
      mask[index] = true;
    }

    open = closeIndex;
  }

  return mask;
}

// `<` outside code → `&lt;`, autolinks kept; an agent's own `\<` loses its
// backslash (`\&lt;` would print the entity verbatim).
function escapeAngles(text: string, inCode: boolean[]): string {
  let result = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char !== '<' || inCode[index]) {
      result += char;
      continue;
    }

    const autolink = text.slice(index).match(AUTOLINK_RE);

    if (autolink) {
      result += autolink[0];
      index += autolink[0].length - 1;
      continue;
    }

    let backslashes = 0;

    while (result.endsWith('\\'.repeat(backslashes + 1))) {
      backslashes += 1;
    }

    if (backslashes % 2 === 1) {
      result = result.slice(0, -1);
    }

    result += '&lt;';
  }

  return result;
}

function endsWithHardBreak(line: string): boolean {
  if (/ {2,}$/.test(line)) {
    return true;
  }

  const backslashes = line.match(/\\+$/)?.[0].length ?? 0;

  return backslashes % 2 === 1;
}

// Number of header cells of the table starting at tokens[index].
function tableColumns(tokens: Token[], index: number): number {
  let columns = 0;

  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];

    if (!token || token.type === 'tr_close') {
      break;
    }

    if (token.type === 'th_open' || token.type === 'td_open') {
      columns += 1;
    }
  }

  return columns;
}

export function prepareRichMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const tokens = parse(lines.join('\n'));

  // Lines left verbatim: code blocks and wide tables (sent as code).
  const verbatim = new Set<number>();
  // Wide top-level tables: first line → last line (exclusive).
  const wideTables = new Map<number, number>();
  // Paragraphs: first line → last line (exclusive).
  const paragraphs = new Map<number, number>();

  tokens.forEach((token, index) => {
    if (!token.map) {
      return;
    }

    const [start, end] = token.map;

    if (token.type === 'fence' || token.type === 'code_block') {
      for (let line = start; line < end; line += 1) {
        verbatim.add(line);
      }
    } else if (
      token.type === 'table_open' &&
      token.level === 0 &&
      tableColumns(tokens, index) > RICH_TABLE_MAX_COLUMNS
    ) {
      wideTables.set(start, end);

      for (let line = start; line < end; line += 1) {
        verbatim.add(line);
      }
    } else if (token.type === 'paragraph_open') {
      paragraphs.set(start, end);
    }
  });

  const output: string[] = [];

  for (let line = 0; line < lines.length; ) {
    const wideEnd = wideTables.get(line);

    if (wideEnd !== undefined) {
      output.push('```', ...lines.slice(line, wideEnd), '```');
      line = wideEnd;
      continue;
    }

    if (verbatim.has(line)) {
      output.push(lines[line] ?? '');
      line += 1;
      continue;
    }

    // A paragraph is scanned as a whole (a code span may cross its lines);
    // any other line (heading, table row, blank) on its own.
    const end = paragraphs.get(line) ?? line + 1;
    const group = lines.slice(line, end);
    const text = group.join('\n');
    const inCode = inlineCodeMask(text);
    let offset = 0;

    group.forEach((groupLine, index) => {
      const lineEnd = offset + groupLine.length;
      let prepared = escapeAngles(groupLine, inCode.slice(offset, lineEnd));
      const lastLine = index === group.length - 1;

      if (!lastLine && !inCode[lineEnd - 1] && !endsWithHardBreak(groupLine) && groupLine.trim()) {
        prepared += '  ';
      }

      output.push(prepared);
      offset = lineEnd + 1;
    });

    line = end;
  }

  return output.join('\n');
}

// --- splitting -------------------------------------------------------------

type Piece = { text: string; blocks: number };

function countBlocks(tokens: Token[]): number {
  return tokens.filter(token => COUNTED_BLOCKS.has(token.type)).length;
}

function fits(piece: Piece, limits: RichLimits): boolean {
  return piece.text.length <= limits.maxChars && piece.blocks <= limits.maxBlocks;
}

// Greedy packing of consecutive pieces into messages within the limits.
function pack(pieces: Piece[], limits: RichLimits): string[] {
  const chunks: string[] = [];
  let current: Piece | null = null;

  const flush = () => {
    const text = current?.text.trim();

    if (text) {
      chunks.push(text);
    }

    current = null;
  };

  for (const piece of pieces) {
    const merged: Piece | null = current ? { text: `${current.text}\n${piece.text}`, blocks: current.blocks + piece.blocks } : null;

    if (merged && fits(merged, limits)) {
      current = merged;
    } else {
      flush();
      current = piece;
    }
  }

  flush();

  return chunks;
}

// Last resort for a single line over the limit: cut by characters, never
// inside a surrogate pair.
function cutLine(line: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = line;

  while (rest.length > maxChars) {
    let cut = maxChars;
    const code = rest.charCodeAt(cut - 1);

    if (code >= 0xd800 && code <= 0xdbff) {
      cut -= 1;
    }

    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  parts.push(rest);

  return parts;
}

function splitLines(lines: string[], limits: RichLimits): string[] {
  const pieces = lines.flatMap(line => cutLine(line, limits.maxChars).map(text => ({ text, blocks: 0 })));

  return pack(pieces, { ...limits, maxBlocks: Number.POSITIVE_INFINITY });
}

// One top-level block over the limits, split the way it stays itself in
// every part: a code block re-fenced, a table with its header repeated, a
// list at item boundaries; anything else by lines.
function splitBlock(lines: string[], first: number, tokens: Token[], limits: RichLimits): string[] {
  const head = tokens[0];

  if (head?.type === 'fence') {
    const open = `${head.markup}${head.info}`;
    const close = head.markup;
    const inner = splitLines(head.content.replace(/\n$/, '').split('\n'), {
      ...limits,
      maxChars: limits.maxChars - open.length - close.length - 2,
    });

    return inner.map(code => `${open}\n${code}\n${close}`);
  }

  if (head?.type === 'table_open') {
    const header = lines.slice(0, 2).join('\n');
    const rows = lines.slice(2).map(text => ({ text, blocks: 1 }));
    const budget = {
      maxChars: limits.maxChars - header.length - 1,
      maxBlocks: limits.maxBlocks - 2,
    };

    return pack(rows, budget).map(body => `${header}\n${body}`);
  }

  if (head?.type === 'bullet_list_open' || head?.type === 'ordered_list_open') {
    const starts = tokens
      .filter(token => token.type === 'list_item_open' && token.level === 1 && token.map)
      .map(token => (token.map?.[0] ?? first) - first);

    if (starts.length > 1) {
      const items = starts.map((start, index) => {
        const end = starts[index + 1] ?? lines.length;
        const itemTokens = tokens.filter(token => {
          const line = (token.map?.[0] ?? -1) - first;

          return line >= start && line < end;
        });

        return { text: lines.slice(start, end).join('\n'), blocks: countBlocks(itemTokens) + 1 };
      });

      // An item over the limits on its own is cut by lines, each part a
      // message of its own.
      const parts = items.flatMap(item =>
        fits(item, limits)
          ? [item]
          : splitLines(item.text.split('\n'), limits).map(text => ({ text, blocks: limits.maxBlocks })),
      );

      return pack(parts, limits);
    }
  }

  return splitLines(lines, limits);
}

export function splitRichMarkdown(text: string, limits: RichLimits = DEFAULT_LIMITS): string[] {
  if (!text.trim()) {
    return [];
  }

  const tokens = parse(text);

  if (fits({ text, blocks: countBlocks(tokens) }, limits)) {
    return [text.trim()];
  }

  const lines = text.split('\n');
  // Top-level blocks: where each starts; the first piece also takes the
  // lines before it, the last one runs to the end — no line is dropped
  // (link reference definitions have no token of their own).
  const starts: { line: number; index: number }[] = [];

  tokens.forEach((token, index) => {
    if (token.level === 0 && token.nesting >= 0 && token.map && token.type !== 'inline') {
      starts.push({ line: token.map[0], index });
    }
  });

  const pieces: Piece[] = [];

  starts.forEach((start, position) => {
    const next = starts[position + 1];
    const firstLine = position === 0 ? 0 : start.line;
    const endLine = next ? next.line : lines.length;
    const blockTokens = tokens.slice(start.index, next ? next.index : tokens.length);
    const piece = { text: lines.slice(firstLine, endLine).join('\n'), blocks: countBlocks(blockTokens) };

    if (fits(piece, limits)) {
      pieces.push(piece);
    } else {
      const parts = splitBlock(lines.slice(start.line, endLine), start.line, blockTokens, limits);

      if (firstLine < start.line) {
        pieces.push({ text: lines.slice(firstLine, start.line).join('\n'), blocks: 0 });
      }

      // Each part of an oversize block is a message of its own.
      pieces.push(...parts.map(part => ({ text: part, blocks: limits.maxBlocks })));
    }
  });

  return pack(pieces, limits);
}

export function formatTelegramMarkdown(source: string, limits: RichLimits = DEFAULT_LIMITS): string[] {
  return splitRichMarkdown(prepareRichMarkdown(source), limits);
}
