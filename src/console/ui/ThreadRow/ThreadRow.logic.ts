// Pure rules of a thread row (design: ThreadRow renderVals): which states
// are live (dot on the avatar, "since …"), the details line and the search
// match split of the title and summary.

import type { StateName } from '../atoms/state.ts';
import { countOf } from '../../lib/format/index.ts';

export type ActiveState = 'run' | 'wait' | 'act';

export function isActiveState(state: StateName): state is ActiveState {
  return state === 'run' || state === 'wait' || state === 'act';
}

export type TextPart = { text: string; hit: boolean };

// Splits text into plain and matched parts, the match compared without
// case (the search is), the original casing kept.
export function highlightParts(text: string, hit?: string): TextPart[] {
  if (!text) {
    return [];
  }
  if (!hit) {
    return [{ text, hit: false }];
  }
  const lower = text.toLowerCase();
  const needle = hit.toLowerCase();
  const parts: TextPart[] = [];
  let from = 0;

  for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) {
      parts.push({ text: text.slice(from, at), hit: false });
    }
    parts.push({ text: text.slice(at, at + hit.length), hit: true });
    from = at + hit.length;
  }
  if (from < text.length) {
    parts.push({ text: text.slice(from), hit: false });
  }

  return parts;
}

export type ThreadRowMetaInput = {
  agent: string;
  noAgent?: boolean;
  headless?: boolean;
  project?: string;
  kids?: number;
  last?: string;
  lastCode?: string;
};

export type ThreadRowMetaItem = { kind: 'text'; text: string } | { kind: 'tag'; text: string } | { kind: 'kids'; text: string } | { kind: 'code'; text: string };

// The details line: agent · headless · project · N children · last action
// (a command as a chip, otherwise text). Missing pieces are skipped.
export function threadRowMeta({ agent, noAgent, headless, project, kids = 0, last, lastCode }: ThreadRowMetaInput): ThreadRowMetaItem[] {
  const items: ThreadRowMetaItem[] = [];

  if (!noAgent) {
    items.push({ kind: 'text', text: agent });
  }
  if (headless) {
    items.push({ kind: 'tag', text: 'headless' });
  }
  if (project) {
    items.push({ kind: 'text', text: project });
  }
  if (kids > 0) {
    items.push({ kind: 'kids', text: countOf(kids, 'child', 'children') });
  }
  if (lastCode) {
    items.push({ kind: 'code', text: lastCode });
  } else if (last) {
    items.push({ kind: 'text', text: last });
  }

  return items;
}
