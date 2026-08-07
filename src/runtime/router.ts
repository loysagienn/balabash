// The thread router (§7.3 — the "one router consumer" decision): a single
// consumer over the types that need delivery into runs, with the in-memory
// threadId → run registry. Runs are ephemeral and live in this process, so
// there is no reason to multiply cursors; global order is preserved, and a
// slow run does not block others — delivery is a non-blocking inbox wake,
// the run's turn is asynchronous.
//
// Stage 3 routing:
// - user.message        → the author's thread run (lazy rise for main threads)
// - thread.started      → spawn the child's run (dynamic agents; injected hook)
// - thread.cancel       → execute the command: write the terminal; the abort
//                         follows from routing that terminal
// - terminals           → abort+drop the terminated thread's run, wake the
//                         addressed parent
// - thread.progress     → wake the addressed parent
//
// Runs come from hooks injected by the composition root: the runtime routes,
// it does not know which agent implements a thread (layering §3: runtime
// knows only core; the coordinator factory and the dynamic-agent spawner
// plug in from above).

import type { Event, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { startConsumer } from '../core/consumers.ts';
import type { Consumer } from '../core/consumers.ts';
import {
  CONNECTION_COMPLETED,
  CONNECTION_FAILED,
  CONNECTION_REAUTHORIZATION_REQUIRED,
  OAUTH_CLIENT_PROVISIONED,
  SECRETS_PROVISIONED,
  SYSTEM_RESTART_COMPLETED,
  TERMINAL_TYPES,
  THREAD_CANCEL,
  THREAD_CANCELLED,
  THREAD_PROGRESS,
  THREAD_STARTED,
} from '../core/envelope.ts';
import { getThread } from '../core/threads.ts';
import { abortAndDropRun, getRun, registerRun } from './runs.ts';
import type { RegisteredRun } from './runs.ts';

export type RoutedRun = RegisteredRun;

type RouterHooks = {
  // Lazy rise (§5.5) on a delivered event — today only coordinator runs of
  // main threads; null = this thread has no lazily risable run.
  createRun(thread: Thread): RoutedRun | null;
  // Explicit spawn on thread.started of a child thread. Returning null means
  // the spawn failed; the hook is responsible for journaling the failure.
  spawnRun(thread: Thread, startedEvent: Event): Promise<RoutedRun | null>;
};

const ROUTED_TYPES = [
  'user.message',
  THREAD_STARTED,
  THREAD_CANCEL,
  THREAD_PROGRESS,
  ...TERMINAL_TYPES,
  // Integration outcomes (stage 4): thread-addressed facts from the web
  // callbacks and detectors — delivered to the addressee like any other
  // addressed event (already redirected to main when the addressee died).
  CONNECTION_COMPLETED,
  CONNECTION_FAILED,
  CONNECTION_REAUTHORIZATION_REQUIRED,
  OAUTH_CLIENT_PROVISIONED,
  SECRETS_PROVISIONED,
  // The fresh process reports a finished restart to the requester thread
  // (redirected to main when the requester is gone) — wake the addressee.
  SYSTEM_RESTART_COMPLETED,
];

export function startThreadRouter({ createRun, spawnRun }: RouterHooks): Consumer {
  // Wake the run owning threadId, lazily rising it when the hook allows.
  const deliver = async (threadId: string, event: Event): Promise<void> => {
    let run = getRun(threadId);

    if (!run) {
      const thread = await getThread(threadId);

      if (!thread || thread.status !== 'active') {
        return;
      }

      const created = createRun(thread);

      if (!created) {
        return;
      }

      registerRun(threadId, created);
      run = created;
    }

    run.accept(event);
  };

  return startConsumer({
    name: 'thread-router',
    types: () => ROUTED_TYPES,
    handler: async event => {
      // Birth of a child thread: start its run. The parent is not woken —
      // it initiated the spawn, and the event rides along in its transcript.
      if (event.type === THREAD_STARTED) {
        if (!event.targetThreadId || !event.threadId) {
          // A main thread: its coordinator rises lazily on the first
          // delivered event.
          return;
        }

        const thread = await getThread(event.threadId);

        if (!thread || thread.status !== 'active') {
          return;
        }

        const run = await spawnRun(thread, event);

        if (run) {
          registerRun(thread.id, run);
        }

        return;
      }

      // The cancel command: execute by writing the terminal. The cascade and
      // the projection update happen inside append; the abort follows when
      // the terminal event is routed. A target that terminated in between is
      // a no-op (§4.3).
      if (event.type === THREAD_CANCEL) {
        if (!event.targetThreadId || !event.userId) {
          return;
        }

        const reason = typeof event.payload.reason === 'string' ? event.payload.reason : 'cancelled';

        await appendEvent({
          type: THREAD_CANCELLED,
          actor: 'system',
          userId: event.userId,
          threadId: event.targetThreadId,
          payload: { reason, requestedBy: event.actor === 'agent' ? (event.agentName ?? 'agent') : event.actor },
        });

        return;
      }

      // A terminal: the thread is over — stop its run; then wake the parent
      // it is addressed to (the coordinator reacts to summaries; cascade
      // cancellations stop descendant runs one terminal at a time).
      if (TERMINAL_TYPES.has(event.type)) {
        if (event.threadId) {
          abortAndDropRun(event.threadId, event.type);
        }

        if (event.targetThreadId) {
          await deliver(event.targetThreadId, event);
        }

        return;
      }

      // Addressed events wake the addressee, plain events their author's
      // thread (§7.3).
      const threadId = event.targetThreadId ?? event.threadId;

      if (threadId) {
        await deliver(threadId, event);
      }
    },
  });
}
