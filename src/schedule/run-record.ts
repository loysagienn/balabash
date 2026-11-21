// Shared data shapes for the journal, its API and catalog readers.
import type { JsonValue } from '../core/contract.ts';

export type RunTrigger = 'cron' | 'at' | 'manual';
export type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'aborted';

// A run as a list carries it: without its code, its value and its console.
export type RunSummary = {
  id: string;
  // The slug of the task as it was at fire time.
  slug: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  // The run returned a value other than null.
  hasValue: boolean;
};

export type RunRecord = RunSummary & {
  code: string;
  value: JsonValue | null;
  // What ended a failed or timed-out run: the kind of the error and its
  // message, then its details when it has any.
  error: string | null;
  console: string;
  consoleTruncated: boolean;
};
