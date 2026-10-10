// Pure rules of the thread page: the time words of the header, the plate
// in place of the composer, the stage of the feed body.

import type { Thread } from '../../../core/contract.ts';
import type { ThreadFeed } from '../../store/feed/reducer.ts';
import { durationLabel, rangeLabel, sinceLabel } from '../../lib/format/index.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { isActiveState } from '../../ui/ThreadRow/ThreadRow.logic.ts';
import type { StateName } from '../../ui/atoms/state.ts';

// "since 14:02, running 2h 36m" / "13:17 → 13:59, 42m".
export function threadTimeLabel(thread: Thread, state: StateName, now: Date): string {
  if (isActiveState(state)) {
    return `${sinceLabel(thread.createdAt, now)}, running ${durationLabel(now.getTime() - thread.createdAt.getTime())}`;
  }

  return `${rangeLabel(thread.createdAt, thread.updatedAt, now)}, ${durationLabel(thread.updatedAt.getTime() - thread.createdAt.getTime())}`;
}

// The commands of the header: an active thread with a parent takes "Stop
// turn" and "Cancel thread" (the main thread is eternal and takes neither);
// a stop needs a turn in flight.
export function threadCommands(thread: Thread, state: StateName): { running: boolean; stopEnabled: boolean } {
  const running = thread.status === 'active' && thread.parentId !== null;

  return { running, stopEnabled: running && state === 'run' };
}

// The words of the cancel confirmation (design: ThreadScreen, modal).
export function cancelWords(thread: Thread): string {
  return `The “${thread.agent}” agent will stop and the thread will end without a summary. The parent thread will be notified. This can’t be undone.`;
}

export type ComposerLockWords = { icon: IconName; text: string; strong?: string };

// Why there is no composer: the thread is headless, or it is over.
export function composerLock(thread: Thread): ComposerLockWords | null {
  switch (thread.status) {
    case 'completed':
      return { icon: 'lock', text: 'Thread completed. To continue, ask the coordinator to start a new thread.' };
    case 'failed':
      return { icon: 'octagon-x', text: 'Thread crashed. The parent agent or the coordinator can restart it.' };
    case 'cancelled':
      return { icon: 'circle-slash', text: 'Thread cancelled.' };
    default:
      return thread.headless ? { icon: 'eye-off', strong: 'Headless thread', text: ` — the ${thread.agent} talks only to its parent thread. You can’t write here, but everything is visible.` } : null;
  }
}

export type FeedStage = 'skeleton' | 'failed' | 'ready';

// Before the first chunk: a skeleton while it loads, the error when it
// failed; once any chunk landed (or the tail already brought events) the
// items show, with the chunk state at the top of the feed.
export function feedStage(feed: ThreadFeed, eventCount: number): FeedStage {
  if (feed.knownFrom !== null || feed.exhausted || eventCount > 0) {
    return 'ready';
  }

  return feed.error ? 'failed' : 'skeleton';
}

// The top line of a ready feed: nothing more to load, the next chunk
// loading, the chunk's error, or the invitation the sentinel watches.
export type FeedTop = 'complete' | 'loading' | 'error' | 'more';

export function feedTop(feed: ThreadFeed): FeedTop {
  if (feed.exhausted) {
    return 'complete';
  }
  if (feed.request) {
    return 'loading';
  }

  return feed.error ? 'error' : 'more';
}

// What the scroll box of the feed does after its items changed (the hook
// measures, this decides). The first ready view opens at the end. An
// earlier chunk — knownFrom moved — keeps the same element under the eye:
// by the shift of an anchored item still in the DOM, else (the first items
// re-keyed when older actions merged into their group) by the growth of
// the content. Any other change while the end is in view follows it; a
// reader up in the history is left in place.
export type FeedScrollSeen = { knownFrom: bigint | null; height: number };
export type FeedScrollMove = { kind: 'open' } | { kind: 'end' } | { kind: 'by'; px: number } | null;

export function feedScrollMove(input: { previous: FeedScrollSeen | null; knownFrom: bigint | null; atEnd: boolean; anchorShift: number | null; height: number }): FeedScrollMove {
  const { previous, knownFrom, atEnd, anchorShift, height } = input;

  if (!previous) {
    return { kind: 'open' };
  }
  if (previous.knownFrom !== knownFrom) {
    const px = anchorShift ?? height - previous.height;

    return px === 0 ? null : { kind: 'by', px };
  }

  return atEnd ? { kind: 'end' } : null;
}

// Which measured item the eye is on: the last one whose top is at or above
// the scroll position (it straddles the top of the view), the first when
// none is. offsets — the items' tops from the top of the content, ascending.
export function anchorIndex(offsets: readonly number[], scrollTop: number): number {
  let index = 0;

  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i]! <= scrollTop) {
      index = i;
    } else {
      break;
    }
  }

  return index;
}
