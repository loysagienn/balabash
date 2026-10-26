// Pure rules of the thread page: the time words of the header, the plate
// in place of the composer, the stage of the feed body.

import type { Thread } from '../../../core/contract.ts';
import type { ThreadFeed } from '../../store/feed/reducer.ts';
import { durationLabel, rangeLabel, sinceLabel, timeOfDay } from '../../lib/format/index.ts';
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

// The controls of an active child thread (design-system rule 16, spec
// thread-controls-and-remote-agents.md §1), in two groups. The turn: "Stop
// turn" — enabled only while a turn runs; a remote thread (the mirror of a
// session elsewhere) adds "Pause" — enabled only while the session awaits
// a message and no Finish was asked (a working session is stopped, not
// paused; a question waits for a decision; a sleeping thread sleeps
// already). The thread: "Finish thread" (the agent is asked to wrap up and
// end the thread itself — a remote session, for its closing summary) and
// "Cancel thread". The main thread is eternal and takes none; a closed
// thread has none.
export function threadCommands(thread: Thread, state: StateName, finishAsked: boolean = false): { running: boolean; stopEnabled: boolean; remote: boolean; pauseEnabled: boolean } {
  const running = thread.status === 'active' && thread.parentId !== null;
  const remote = running && thread.remote;

  return { running, stopEnabled: running && state === 'run', remote, pauseEnabled: remote && state === 'wait' && !finishAsked };
}

// A finish already asked for — the time of the thread.finish addressed to
// this thread among its loaded events (any requester), null when none: the
// agent is wrapping up, asking again only repeats the request — the
// button reads "Finish requested" and a note says what happens next. A
// thread's events include the commands it gave its own children (it is
// their author); a thread.finish it sent down is the child's, not its own.
export function finishAskedAt(events: readonly { type: string; targetThreadId: string | null; createdAt: Date }[], threadId: string): Date | null {
  const asked = events.find(event => event.type === 'thread.finish' && event.targetThreadId === threadId);

  return asked ? asked.createdAt : null;
}

// The deadline of a remote finish: with no closing summary in 10 minutes
// (src/remote/engine.ts FINISH_TIMEOUT_MS) the thread ends with the
// session's last words.
export const REMOTE_FINISH_TIMEOUT_MS = 10 * 60_000;

// The note under the controls once Finish was asked (design: ThreadRail
// finishNote).
export function finishNote(thread: Thread, askedAt: Date): string {
  if (thread.remote) {
    return `Asked at ${timeOfDay(askedAt)} — the session writes a closing summary and the thread ends with it; with no summary by ${timeOfDay(new Date(askedAt.getTime() + REMOTE_FINISH_TIMEOUT_MS))}, it ends with the session’s last words.`;
  }

  return `Asked at ${timeOfDay(askedAt)} — the agent finishes its turn, wraps up and ends the thread with its report. To stop at once, cancel the thread.`;
}

// The note under the state of a remote thread (design: ThreadRail
// stateNote): asleep, or closed with its session still open; null otherwise.
export function stateNote(thread: Thread, state: StateName): string | null {
  if (!thread.remote) {
    return null;
  }
  if (state === 'paused') {
    return 'Asleep: the session is checked every 15 minutes. A message, or activity in the external system, wakes it.';
  }
  if (state === 'done' || state === 'off') {
    return 'The session itself stays open in the external system — ending the thread doesn’t close it.';
  }

  return null;
}

// The words of the finish confirmation (spec §3): the agent ends the
// thread itself, in its own time — a remote session with its closing
// summary, and the session stays open.
export function finishWords(thread: Thread): string {
  if (thread.remote) {
    return `The “${thread.agent}” session will be asked for a closing summary, and the thread will end with it — with no summary in 10 minutes, it ends with the session’s last words. The session itself stays open in the external system.`;
  }

  return `The “${thread.agent}” agent will be asked to wrap up, write its report and end the thread itself. It finishes its current turn first, so this takes a moment. To stop at once, cancel the thread instead.`;
}

// The words of the cancel confirmation (spec §3). A remote thread's cancel
// closes the mirror alone: the session elsewhere is not touched — a turn
// in flight runs on there.
export function cancelWords(thread: Thread): string {
  if (thread.remote) {
    return `The thread will end now, without a summary. The “${thread.agent}” session is not touched and keeps running in the external system. The parent thread will be notified. This can’t be undone.`;
  }

  return `The “${thread.agent}” agent will stop and the thread will end now, without a summary. The parent thread will be notified. This can’t be undone.`;
}

export type ComposerLockWords = { icon: IconName; text: string; strong?: string };

export type ComposerLockInput = {
  // The agent of the parent thread; null while unknown.
  parentAgent: string | null;
  // A remote thread crashed because its session is gone (the engine's
  // failure, read from the loaded thread.failed).
  sessionGone: boolean;
};

// Why there is no composer: the thread is headless (a remote child's
// questions are still the user's to decide), or it is over (a remote
// thread's session outlives it).
export function composerLock(thread: Thread, input: ComposerLockInput = { parentAgent: null, sessionGone: false }): ComposerLockWords | null {
  switch (thread.status) {
    case 'completed':
      return thread.remote
        ? { icon: 'lock', text: 'Thread completed. The session stays open in the external system; to continue, ask the coordinator to adopt it in a new thread.' }
        : { icon: 'lock', text: 'Thread completed. To continue, ask the coordinator to start a new thread.' };
    case 'failed':
      return thread.remote && input.sessionGone ? { icon: 'octagon-x', text: 'Thread crashed: the session is gone.' } : { icon: 'octagon-x', text: 'Thread crashed. The parent agent or the coordinator can restart it.' };
    case 'cancelled':
      return { icon: 'circle-slash', text: 'Thread cancelled.' };
    default:
      if (!thread.headless) {
        return null;
      }

      return thread.remote
        ? { icon: 'eye-off', strong: 'Headless thread', text: ` — ${thread.agent} talks only to ${input.parentAgent ?? 'its parent thread'}. You can’t write here; its questions are still yours to decide.` }
        : { icon: 'eye-off', strong: 'Headless thread', text: ` — the ${thread.agent} talks only to ${input.parentAgent ? `the ${input.parentAgent}` : 'its parent thread'}. You can’t write here, but you can see everything.` };
  }
}

// Whether the loaded events say the remote session is gone (the engine's
// one failure: src/remote/engine.ts).
export function remoteSessionGone(events: readonly { type: string; payload: unknown }[]): boolean {
  return events.some(event => event.type === 'thread.failed' && (event.payload as { error?: unknown }).error === 'the remote session is gone');
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
// measures, this decides). The first ready view opens at the end — or, when
// history brought the thread back with the place it was left at (`restore`,
// the router's `scroll`), at that place. Any change while the end is in
// view follows it — a short feed whose earlier part lands included (a
// thread opened before its history loaded stays at its end). A change at
// the top of the drawn feed — `top` moved: an earlier chunk landed, earlier
// items were drawn — keeps a reader up in the history on the same element:
// by the shift of an anchored item still in the DOM, else (the first items
// re-keyed when older actions merged into their group) by the growth of the
// content. Otherwise a reader up in the history is left in place.
export type FeedScrollSeen = { top: string; height: number };
export type FeedScrollMove = { kind: 'open' } | { kind: 'to'; px: number } | { kind: 'end' } | { kind: 'by'; px: number } | null;

export function feedScrollMove(input: { previous: FeedScrollSeen | null; top: string; atEnd: boolean; anchorShift: number | null; height: number; restore: number | null }): FeedScrollMove {
  const { previous, top, atEnd, anchorShift, height, restore } = input;

  if (!previous) {
    return restore === null ? { kind: 'open' } : { kind: 'to', px: restore };
  }
  if (atEnd) {
    return { kind: 'end' };
  }
  if (previous.top !== top) {
    const px = anchorShift ?? height - previous.height;

    return px === 0 ? null : { kind: 'by', px };
  }

  return null;
}

// The drawn part of the feed. A long thread keeps its loaded history in the
// store, but the page draws only its end — FEED_OPEN_ITEMS items, a few
// screens of the main thread — and draws earlier items FEED_REVEAL_ITEMS at
// a time as the reader nears the top; only when every loaded item is drawn
// does the next chunk load from the network. The window is fixed by its
// first item (`key`), so the tail growing at the bottom never moves what
// the reader sees; `count` (items from the end when the key was set) stands
// in when the key is gone — an earlier chunk re-keyed the first item (older
// actions merged into its group, a card met its start). `knownFrom` — the
// feed's lower bound the window has seen: a chunk landing draws the next
// part of it.
export const FEED_OPEN_ITEMS = 40;
export const FEED_REVEAL_ITEMS = 30;

export type FeedWindow = { key: string | null; count: number; knownFrom: bigint | null };

export function openFeedWindow(knownFrom: bigint | null, key: string | null = null): FeedWindow {
  return { key, count: FEED_OPEN_ITEMS, knownFrom };
}

// The index of the first drawn item.
export function feedWindowStart(keys: readonly string[], win: FeedWindow): number {
  if (win.key !== null) {
    const index = keys.indexOf(win.key);

    if (index >= 0) {
      return index;
    }
  }

  return Math.max(0, keys.length - win.count);
}

function windowAt(keys: readonly string[], start: number, knownFrom: bigint | null): FeedWindow {
  return { key: keys[start] ?? null, count: keys.length - start, knownFrom };
}

// The window `step` items earlier.
export function revealEarlier(keys: readonly string[], win: FeedWindow, step: number = FEED_REVEAL_ITEMS): FeedWindow {
  return windowAt(keys, Math.max(0, feedWindowStart(keys, win) - step), win.knownFrom);
}

// The window for the feed as it is now, or the same object when nothing
// changes (the page sets it while rendering): until the first chunk from
// the head lands (`head` false) the window is the last items, whatever the
// tail brings; then it is fixed by its first item; a later chunk landing
// (knownFrom moved) draws the next part of it.
export function settleFeedWindow(keys: readonly string[], win: FeedWindow, knownFrom: bigint | null, head: boolean): FeedWindow {
  if (!head || keys.length === 0) {
    return win;
  }
  if (win.key === null) {
    return windowAt(keys, feedWindowStart(keys, win), knownFrom);
  }
  if (win.knownFrom !== knownFrom) {
    return revealEarlier(keys, { ...win, knownFrom });
  }

  return win;
}

// What the reader nearing the top of the drawn feed asks for: earlier
// items the store already holds, else the next chunk — unless one is in
// flight, failed (Retry is the reader's call) or the history is complete.
export function nearTopAction(start: number, feed: ThreadFeed): 'reveal' | 'load' | null {
  if (start > 0) {
    return 'reveal';
  }

  return feed.knownFrom !== null && !feed.exhausted && !feed.request && !feed.error ? 'load' : null;
}

// The reader is near the top when the top of the drawn feed is less than a
// screen above the view — earlier items are drawn before they are reached.
export function isNearTop(sentinelBottom: number, viewTop: number, viewHeight: number): boolean {
  return sentinelBottom > viewTop - viewHeight;
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
