// The facade of a remote thread: what the thread router registers in place
// of a run. A remote thread has no run — nothing in memory, no process, no
// turn of ours — so the facade holds no state: every call is forwarded to
// the engine by threadId, and a facade may be risen again at any time (the
// router rises one lazily on the first delivered event, after a restart as
// before). Cheap by construction. A delivered event is not handed over —
// the engine reads the thread's inbound events from the log by its own
// durable position; the facade only wakes it.

import type { RegisteredRun } from '../runtime/runs.ts';

export type FacadeEngine = {
  // An event was delivered to the thread: apply the inbound events after
  // the row's position (the engine's inbound side). Non-blocking.
  wake(threadId: string): void;
  // thread.interrupt: stop the session's turn in flight.
  stop(threadId: string): void;
  // A terminal was routed for the thread: it is over here; the session is
  // not touched.
  forget(threadId: string, reason: string): void;
};

export function createRemoteFacade(threadId: string, engine: FacadeEngine): RegisteredRun {
  return {
    accept: () => {
      engine.wake(threadId);
    },
    interrupt: () => {
      engine.stop(threadId);
    },
    abort: reason => {
      engine.forget(threadId, reason);
    },
  };
}
