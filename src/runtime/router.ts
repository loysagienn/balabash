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
// - thread.interrupt    → the addressee's soft stop (risen lazily like any
//                         delivered event — a remote thread's facade)
// - thread.finish/pause/decide → wake the addressed remote thread's facade
//
// Runs come from hooks injected by the composition root: the runtime routes,
// it does not know which agent implements a thread (layering §3: runtime
// knows only core; the coordinator factory, the dynamic-agent spawner and
// the remote engine's facade — a remote thread has no run, its "run" is a
// stateless facade over the engine, risen on demand — plug in from above).

import type { Event, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { startConsumer } from '../core/consumers.ts';
import type { Consumer } from '../core/consumers.ts';
import {
  CONNECTION_COMPLETED,
  CONNECTION_FAILED,
  CONNECTION_REAUTHORIZATION_REQUIRED,
  OAUTH_CLIENT_PROVISIONED,
  SCHEDULE_FIRED,
  SECRETS_PROVISIONED,
  SYSTEM_RESTART_COMPLETED,
  TERMINAL_TYPES,
  THREAD_CANCEL,
  THREAD_CANCELLED,
  THREAD_DECIDE,
  THREAD_FINISH,
  THREAD_INTERRUPT,
  THREAD_MESSAGE,
  THREAD_PAUSE,
  THREAD_PROGRESS,
  THREAD_STARTED,
} from '../core/envelope.ts';
import { getThread } from '../core/threads.ts';
import { abortAndDropRun, getRun, registerRun } from './runs.ts';
import type { RegisteredRun } from './runs.ts';

export type RoutedRun = RegisteredRun;

type RouterHooks = {
  // Lazy rise (§5.5) on a delivered event — coordinator runs of main
  // threads and the facades of remote threads; null = this thread has no
  // lazily risable run.
  createRun(thread: Thread): RoutedRun | null;
  // Explicit spawn on thread.started of a child thread. Returning null means
  // the spawn failed; the hook is responsible for journaling the failure.
  spawnRun(thread: Thread, startedEvent: Event): Promise<RoutedRun | null>;
};

const ROUTED_TYPES = [
  'user.message',
  THREAD_STARTED,
  THREAD_CANCEL,
  THREAD_INTERRUPT,
  THREAD_MESSAGE,
  THREAD_PROGRESS,
  // The remote thread's commands: delivered to the addressee like any other
  // addressed event — its facade hands them to the engine (a session run,
  // should one ever be addressed, sees a [Balabash event]).
  THREAD_FINISH,
  THREAD_PAUSE,
  THREAD_DECIDE,
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
  // A scheduled task fired into the main thread — wake the coordinator so it
  // interprets the note (or a code task's pushed payload) right away.
  SCHEDULE_FIRED,
];

export function startThreadRouter({ createRun, spawnRun }: RouterHooks): Consumer {
  // The run owning threadId, lazily risen when the hook allows; null when
  // the thread is over or has no risable run.
  const riseRun = async (threadId: string): Promise<RoutedRun | null> => {
    const run = getRun(threadId);

    if (run) {
      return run;
    }

    const thread = await getThread(threadId);

    if (!thread || thread.status !== 'active') {
      return null;
    }

    const created = createRun(thread);

    if (!created) {
      return null;
    }

    registerRun(threadId, created);

    return created;
  };

  // Wake the run owning threadId.
  const deliver = async (threadId: string, event: Event): Promise<void> => {
    const run = await riseRun(threadId);

    run?.accept(event);
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

      // The soft stop: interrupt the addressee's turn in flight — the run
      // itself stays registered and alive. Addressed to a child (one hop
      // down, like thread.cancel). A redirected command (the child died in
      // between) is dropped rather than stopping the main thread. The run
      // rises lazily like for a delivered event: a remote thread has none
      // in memory after a restart, and its stop must still reach the engine.
      if (event.type === THREAD_INTERRUPT) {
        const targetId = event.targetThreadId;

        if (!targetId || 'redirectedFromThreadId' in event.payload) {
          return;
        }

        const run = await riseRun(targetId);

        if (!run) {
          console.log(`[router] interrupt ignored: no run for thread ${targetId}`);

          return;
        }

        try {
          run.interrupt();
        } catch (error) {
          console.error(`[router] interrupt failed thread=${targetId}:`, error);
        }

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
