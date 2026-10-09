// Wording of a thread's state in its header and in a child thread card
// (design: ThreadHead, ChildThread): the six states as a thread reads them.

import type { StateName } from '../atoms/state.ts';

export const THREAD_STATE_LABEL: Record<StateName, string> = {
  run: 'running',
  wait: 'awaiting message',
  act: 'action needed',
  done: 'completed',
  err: 'crashed',
  off: 'cancelled',
};

export function threadStateLabel(state: StateName, label?: string): string {
  return label || THREAD_STATE_LABEL[state];
}
