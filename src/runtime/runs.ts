// In-memory run registry (§7.3): threadId → run. Runs are ephemeral by
// design (§5.5) — the registry is process state, never persisted; restart
// safety comes from the tombstone, not from here.

import type { Event } from '../core/contract.ts';

export type RegisteredRun = {
  // Non-blocking inbox wake; the run's turn is asynchronous.
  accept(event: Event): void;
  // Hard stop from outside (terminal routed for this thread). Idempotent.
  abort(reason: string): void;
};

const runs = new Map<string, RegisteredRun>();

export function registerRun(threadId: string, run: RegisteredRun): void {
  runs.set(threadId, run);
}

export function getRun(threadId: string): RegisteredRun | null {
  return runs.get(threadId) ?? null;
}

export function dropRun(threadId: string): void {
  runs.delete(threadId);
}

// Terminal cleanup: the thread is over — stop the run if it is still alive
// and forget it. Safe to call for threads without a run.
export function abortAndDropRun(threadId: string, reason: string): void {
  const run = runs.get(threadId);

  if (!run) {
    return;
  }

  runs.delete(threadId);

  try {
    run.abort(reason);
  } catch (error) {
    console.error(`[runs:${threadId}] abort failed:`, error);
  }
}
