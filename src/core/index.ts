// Public surface of the core (§3): the event envelope, the single append
// point, consumers, threads + projection, the agent contract. Layers above
// (runtime, harness, capabilities, adapters) depend on this module; nothing
// here knows about them.

export type * from './contract.ts';

export { appendEvent } from './append.ts';
export type { AppendResult } from './append.ts';

export {
  AppendError,
  TERMINAL_TYPES,
  RESERVED_DOMAINS,
  THREAD_STARTED,
  THREAD_PROGRESS,
  THREAD_COMPLETED,
  THREAD_FAILED,
  THREAD_CANCELLED,
  THREAD_CANCEL,
  THREAD_NOTIFICATION,
  SYSTEM_EXCEPTION,
  isCanonicalType,
} from './envelope.ts';
export type { AppendInput } from './envelope.ts';

export { getEventsAfter, getTranscript, getUserEvent, getUserEvents } from './events.ts';

export { startConsumer } from './consumers.ts';
export type { Consumer } from './consumers.ts';

export {
  COORDINATOR_AGENT,
  getThread,
  listThreads,
  getMainThread,
  activeSubtree,
  ensureMainThread,
  startThread,
  tombstoneActiveThreads,
  rebuildThreadsProjection,
} from './threads.ts';

export { stringifyJson, parseJson, prepareObject, restoreObject } from './serialize-json.ts';
