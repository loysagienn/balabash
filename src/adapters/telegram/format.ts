import MarkdownIt from 'markdown-it';

export const TELEGRAM_MESSAGE_LIMIT = 4096;

type RenderEnv = {
  orderedLists?: number[];
  listKinds?: ('ordered' | 'bullet')[];
};

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});

const renderer = markdown.renderer.rules;

renderer.strong_open = () => '<b>';
renderer.strong_close = () => '</b>';
renderer.em_open = () => '<i>';
renderer.em_close = () => '</i>';
renderer.s_open = () => '<s>';
renderer.s_close = () => '</s>';
renderer.paragraph_open = () => '';
renderer.paragraph_close = (tokens, idx) => {
  const next = tokens[idx + 1]?.type;
  return next === 'list_item_close' || next === 'blockquote_close' ? '' : '\n\n';
};
renderer.heading_open = () => '<b>';
renderer.heading_close = () => '</b>\n\n';
renderer.blockquote_open = () => '<blockquote>';
renderer.blockquote_close = () => '</blockquote>\n';
renderer.softbreak = () => '\n';
renderer.hardbreak = () => '\n';
renderer.hr = () => '────────\n';
renderer.image = (tokens, idx) => markdown.utils.escapeHtml(tokens[idx].content);
renderer.fence = (tokens, idx) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/, 1)[0];
  const className = /^[\w+-]+$/.test(language) ? ` class="language-${language}"` : '';
  return `<pre><code${className}>${markdown.utils.escapeHtml(token.content)}</code></pre>\n\n`;
};
// markdown-it 15 types env as possibly undefined; render() below always
// passes an object, so the coercion is safe.
const asEnv = (env: unknown): RenderEnv => (env ?? {}) as RenderEnv;

renderer.bullet_list_open = (_tokens, _idx, _options, env) => {
  (asEnv(env).listKinds ??= []).push('bullet');
  return '';
};
renderer.bullet_list_close = (_tokens, _idx, _options, env) => {
  asEnv(env).listKinds?.pop();
  return '\n';
};
renderer.ordered_list_open = (tokens, idx, _options, env) => {
  const start = Number(tokens[idx]?.attrGet('start') ?? 1);
  const renderEnv = asEnv(env);
  (renderEnv.listKinds ??= []).push('ordered');
  (renderEnv.orderedLists ??= []).push(start);
  return '';
};
renderer.ordered_list_close = (_tokens, _idx, _options, env) => {
  const renderEnv = asEnv(env);
  renderEnv.listKinds?.pop();
  renderEnv.orderedLists?.pop();
  return '\n';
};
renderer.list_item_open = (_tokens, _idx, _options, env) => {
  const renderEnv = asEnv(env);
  if (renderEnv.listKinds?.at(-1) === 'ordered') {
    const stack = renderEnv.orderedLists ?? [1];
    const index = stack.length - 1;
    const value = stack[index] ?? 1;
    stack[index] = value + 1;
    return `${value}. `;
  }
  return '• ';
};
renderer.list_item_close = () => '\n';

export function renderTelegramMarkdown(source: string): string {
  return markdown.render(source, {} as RenderEnv).trim();
}

type OpenTag = { open: string; name: string };

const TOKEN_RE = /<[^>]+>|&(?:amp|lt|gt|quot);|&#\d+;|&#x[\da-f]+;|[\s\S]/giu;

function parsedLength(token: string): number {
  if (token.startsWith('<')) return 0;
  if (token.startsWith('&')) return 1;
  return token.length;
}

function tagName(tag: string): string | null {
  return tag.match(/^<\/?([a-z][\w-]*)/i)?.[1]?.toLowerCase() ?? null;
}

export function splitTelegramHtml(html: string, limit: number): string[] {
  if (!html) return [];
  const chunks: string[] = [];
  const stack: OpenTag[] = [];
  let body = '';
  let length = 0;

  const closeTags = () =>
    [...stack]
      .reverse()
      .map(tag => `</${tag.name}>`)
      .join('');
  const reopenTags = () => stack.map(tag => tag.open).join('');
  const flush = () => {
    const chunk = `${body}${closeTags()}`.trim();
    if (chunk) chunks.push(chunk);
    body = reopenTags();
    length = 0;
  };

  for (const token of html.match(TOKEN_RE) ?? []) {
    const size = parsedLength(token);
    if (size > 0 && length + size > limit) flush();
    body += token;
    length += size;

    if (token.startsWith('</')) {
      const name = tagName(token);
      if (name && stack.at(-1)?.name === name) stack.pop();
    } else if (token.startsWith('<') && !token.startsWith('<!')) {
      const name = tagName(token);
      if (name && !token.endsWith('/>')) stack.push({ open: token, name });
    }
  }
  flush();
  return chunks;
}

export function formatTelegramMarkdown(source: string, limit: number): string[] {
  return splitTelegramHtml(renderTelegramMarkdown(source), limit);
}
