// Pure rules of a thread row (design: ThreadRow renderVals): which states
// are live (dot on the avatar, "since …") and the details line. The search
// match split of the title and summary is the shared atoms/highlight.ts.

import type { StateName } from '../atoms/state.ts';
import { countOf } from '../../lib/format/index.ts';

export type ActiveState = 'run' | 'wait' | 'act';

export function isActiveState(state: StateName): state is ActiveState {
  return state === 'run' || state === 'wait' || state === 'act';
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
