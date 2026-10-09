// Pure helpers of an action's details (FeedAction): the cut of a long
// text with its honest notice, the running timer, a fence the Markdown
// renderer can highlight.

export const DETAIL_MAX = 6000;

export type Cut = { text: string; cut: boolean; total: number };

export function cutText(text: string, max = DETAIL_MAX): Cut {
  return text.length > max ? { text: text.slice(0, max), cut: true, total: text.length } : { text, cut: false, total: text.length };
}

// "0:12" — a running action's timer.
export function actionTimer(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);

  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

// A fenced block the Markdown renderer highlights; the fence outgrows any
// backtick run inside the text.
export function fence(lang: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const ticks = '`'.repeat(longest + 1);

  return `${ticks}${lang}\n${text}\n${ticks}`;
}

