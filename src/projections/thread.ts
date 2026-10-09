// Thread projections shared by the server and the console: the fold of
// lifecycle events into the thread row (append.ts live, threads.ts replay)
// and into the console's threads domain. Pure, node-free — the console
// bundles this file (src/console/tsconfig.json).

import type { JsonObject, ThreadStatus, ThreadSummary } from '../core/contract.ts';

export const THREAD_TERMINAL_TYPES = ['thread.completed', 'thread.failed', 'thread.cancelled'] as const;

// The status a terminal event gives its thread; null for any other type.
export function threadStatusFrom(type: string): Exclude<ThreadStatus, 'active'> | null {
  switch (type) {
    case 'thread.completed':
      return 'completed';
    case 'thread.failed':
      return 'failed';
    case 'thread.cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export type ThreadStartFields = {
  agent: string;
  title: string | null;
  projectId: string | null;
};

// What the row remembers of thread.started: the agent, the starting title
// and the project link. Policy fields (headless, tools, notification, icon)
// stay in the event — consumers read them from there.
export function threadStartFields(payload: JsonObject): ThreadStartFields {
  const { agent, title, projectId } = payload;

  return {
    agent: typeof agent === 'string' ? agent : '',
    title: typeof title === 'string' && title.trim() ? title : null,
    projectId: typeof projectId === 'string' && projectId ? projectId : null,
  };
}

export type ThreadCompletionFields = {
  summary?: ThreadSummary;
  title?: string;
  description?: string;
};

// What thread.completed carries besides the terminal itself: the summary,
// the retrospective description and the one-time title correction (the
// event stays the immutable fact — thread.started keeps the starting title
// forever; the row is a projection of the current state). A field absent
// from the payload is absent from the result: the row keeps its value.
export function threadCompletionFields(payload: JsonObject): ThreadCompletionFields {
  const { summary, title, description } = payload;

  return {
    ...(isSummary(summary) ? { summary } : {}),
    ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
    ...(typeof description === 'string' ? { description } : {}),
  };
}

function isSummary(value: unknown): value is ThreadSummary {
  return typeof value === 'object' && value !== null && typeof (value as ThreadSummary).text === 'string';
}
