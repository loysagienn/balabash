// The draft sync process: when the composer's content is saved to the
// server (store/drafts holds what is unsaved, the handlers do the
// requests; this process keeps the clocks). A thread with unsaved edits is
// saved once the typing rests for DEBOUNCE_MS, and in any case within
// MAX_WAIT_MS of the first unsaved edit — a long dictation is not lost to
// a crash midway. The tab going out of view (the phone's screen off, the
// app swapped away, the page closing) saves at once with keepalive: the
// request outlives the page — on a phone the 5 s rarely come before the
// app is swapped away, and that is the very moment a draft is wanted
// elsewhere. A save that failed waits for the next edit or for the tab's
// return / the stream's reopening (store/drafts nudges) — not a retry
// every few seconds while offline. A conflict waits for the user's word:
// nothing is saved over it. A send in flight stops the clocks: the send
// settles the draft, what is typed meanwhile is saved after it. A process
// over the store, like the stream: lives for the tab, only dispatches.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { draftSave } from '../../store/drafts/actions.ts';
import { isDirty } from '../../store/drafts/reducer.ts';
import type { DraftSync } from '../../store/drafts/reducer.ts';

export const DEBOUNCE_MS = 5_000;
export const MAX_WAIT_MS = 15_000;

export type DraftSyncOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
};

export type DraftSyncDocument = Pick<Document, 'visibilityState'> & {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

export type DraftSyncWindow = {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
};

// Whether the thread's draft wants saving: unsaved edits, no save in
// flight, no conflict waiting for the user, no send in flight — the send
// clears the draft on the server, a save of the text being sent that
// landed after it would write the sent text back as the draft.
export function wantsSave(sync: DraftSync): boolean {
  return isDirty(sync) && sync.saving === null && sync.conflict === null && sync.sending === null;
}

type Clocks = { debounce: ReturnType<typeof setTimeout> | null; maxWait: ReturnType<typeof setTimeout> | null; edits: number };

export function connectStoreToDraftSync(
  store: Store<State, Action>,
  { debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS }: DraftSyncOptions = {},
  doc: DraftSyncDocument | null = typeof document === 'undefined' ? null : document,
  win: DraftSyncWindow | null = typeof window === 'undefined' ? null : window,
): () => void {
  const clocks = new Map<string, Clocks>();
  let nudges = store.getState().drafts.nudges;

  const clear = (clock: Clocks) => {
    if (clock.debounce !== null) {
      clearTimeout(clock.debounce);
      clock.debounce = null;
    }

    if (clock.maxWait !== null) {
      clearTimeout(clock.maxWait);
      clock.maxWait = null;
    }
  };

  const fire = (threadId: string, keepalive: boolean) => {
    const clock = clocks.get(threadId);

    if (clock) {
      clear(clock);
    }

    store.dispatch(draftSave(threadId, { keepalive }));
  };

  const sync = () => {
    const { drafts } = store.getState();
    const nudged = drafts.nudges !== nudges;

    nudges = drafts.nudges;

    for (const [threadId, state] of Object.entries(drafts.byThread)) {
      let clock = clocks.get(threadId);

      if (!clock) {
        clock = { debounce: null, maxWait: null, edits: state.edits };
        clocks.set(threadId, clock);
      }

      const edited = state.edits !== clock.edits;

      clock.edits = state.edits;

      if (!wantsSave(state)) {
        clear(clock);

        continue;
      }

      // After a failure only an edit or a nudge starts the clocks again.
      if (state.failure !== null && !edited && !nudged && clock.debounce === null) {
        continue;
      }

      if (edited || clock.debounce === null) {
        if (clock.debounce !== null) {
          clearTimeout(clock.debounce);
        }

        clock.debounce = setTimeout(() => fire(threadId, false), debounceMs);
      }

      if (clock.maxWait === null) {
        clock.maxWait = setTimeout(() => fire(threadId, false), maxWaitMs);
      }
    }
  };

  // The tab is going away or out of view: whatever is unsaved goes now.
  const flush = () => {
    const { drafts } = store.getState();

    for (const [threadId, state] of Object.entries(drafts.byThread)) {
      if (wantsSave(state)) {
        fire(threadId, true);
      }
    }
  };

  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') {
      flush();
    }
  };

  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', flush);
  sync();

  const unsubscribe = store.subscribe(sync);

  return () => {
    unsubscribe();
    doc?.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', flush);

    for (const clock of clocks.values()) {
      clear(clock);
    }

    clocks.clear();
  };
}
