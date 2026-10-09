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

export type ComposerLockWords = { icon: IconName; text: string; strong?: string };

// Why there is no composer: the thread is headless, or it is over.
export function composerLock(thread: Thread, headless: boolean): ComposerLockWords | null {
  switch (thread.status) {
    case 'completed':
      return { icon: 'lock', text: 'Thread completed. To continue, ask the coordinator to start a new thread.' };
    case 'failed':
      return { icon: 'octagon-x', text: 'Thread crashed. The parent agent or the coordinator can restart it.' };
    case 'cancelled':
      return { icon: 'circle-slash', text: 'Thread cancelled.' };
    default:
      return headless ? { icon: 'eye-off', strong: 'Headless thread', text: ` — the ${thread.agent} talks only to its parent thread. You can’t write here, but everything is visible.` } : null;
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
