// The Telegram markdown contract — the canonical statement of what the
// delivery renderer actually supports. telegram-delivery renders text through
// markdown-it into Telegram HTML (src/adapters/telegram/format.ts): bold,
// italic, strikethrough, code, fences, links, blockquotes, headings (shown as
// bold lines) and lists survive; tables produce HTML Telegram rejects, so a
// table makes sendMessage fail with a parse error. Every prompt and tool
// description stating the subset must import this constant — the renderer is
// the truth, this text is its one mirror.
export const TELEGRAM_MARKDOWN_NOTE =
  'Use only the Markdown subset Telegram renders: **bold**, *italic*, ~~strikethrough~~, `code`, fenced ' +
  'code blocks, [links](https://example.com), blockquotes, headings, simple lists. No tables, no HTML, ' +
  'no Markdown images, no task lists, no deeply nested structures.';
