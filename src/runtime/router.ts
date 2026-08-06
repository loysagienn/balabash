// The thread router (§7.3 — the "one router consumer" decision): a single
// consumer over the types that need delivery into runs, with an in-memory
// threadId → run registry. Runs are ephemeral and live in this process, so
// there is no reason to multiply cursors; global order is preserved, and a
// slow run does not block others — delivery is a non-blocking inbox wake,
// the run's turn is asynchronous.
//
// Runs come from a factory injected by the composition root: the runtime
// routes, it does not know which agent implements a thread. Stage 2: the
// factory only produces coordinator runs for main threads.

import type { Event, Thread } from '../core/contract.ts';
import { startConsumer } from '../core/consumers.ts';
import type { Consumer } from '../core/consumers.ts';
import { getThread } from '../core/threads.ts';

export type RoutedRun = {
  accept: (event: Event) => void;
};

type RunFactory = (thread: Thread) => RoutedRun | null;

// Types the router delivers into runs. Extended at stage 3 (thread.cancel,
// child lifecycle addressed to parents) and stage 5 (accepted domain types).
const ROUTED_TYPES = ['user.message'];

const runs = new Map<string, RoutedRun>();

export function startThreadRouter({ createRun }: { createRun: RunFactory }): Consumer {
  return startConsumer({
    name: 'thread-router',
    types: () => ROUTED_TYPES,
    handler: async event => {
      // Delivery target: the author's thread for plain events, the addressee
      // when the event is addressed (§7.3).
      const threadId = event.targetThreadId ?? event.threadId;

      if (!threadId) {
        return;
      }

      let run = runs.get(threadId);

      if (!run) {
        const thread = await getThread(threadId);

        if (!thread || thread.status !== 'active') {
          return;
        }

        // Lazy rise (§5.5): the run comes up on the first delivered event.
        const created = createRun(thread);

        if (!created) {
          return;
        }

        runs.set(threadId, created);
        run = created;
      }

      run.accept(event);
    },
  });
}

// Terminal cleanup hook for stage 3 (cascade abort drops the run); harmless
// to have now.
export function dropRun(threadId: string): void {
  runs.delete(threadId);
}
