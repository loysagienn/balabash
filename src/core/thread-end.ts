// The report a thread ends with, between the moment the thread leaves it and
// the end of the turn it was left in. A thread does not close itself in the
// middle of a turn: it leaves its report (`end_thread`), goes on to the end
// of the turn — its last words are still to be delivered — and whoever runs
// the turn completes the thread with the report once the turn has run its
// course (src/capabilities/session-run.ts). A turn that is cut — stopped by
// the user, failed, cancelled with its thread — takes its report with it.
//
// The report lives in memory, like the turn it belongs to: a turn does not
// survive the process, and a restart waits for the turns in flight. A report
// left twice in one turn is the later one.

import type { ThreadSummary } from './contract.ts';

export type ThreadReport = {
  // 2–5 words naming the work done: replaces the title the thread started
  // with.
  title: string;
  // What was worked on and how it ended, without the whole report.
  description: string;
  summary: ThreadSummary;
  // The project the work concerned, when the thread names one at its end;
  // absent — the one set at start stays.
  project?: { id: string; slug: string };
};

const reports = new Map<string, ThreadReport>();

export function leaveReport(threadId: string, report: ThreadReport): void {
  reports.set(threadId, report);
}

// The report the thread has left, still in its place.
export function reportLeft(threadId: string): ThreadReport | null {
  return reports.get(threadId) ?? null;
}

// The report the thread has left, taken out: the one who takes it completes
// the thread with it.
export function takeReport(threadId: string): ThreadReport | null {
  const report = reports.get(threadId) ?? null;

  reports.delete(threadId);

  return report;
}

// The turn the report was left in did not run its course (stopped, failed,
// cancelled with its thread): the report is nobody's to take.
export function dropReport(threadId: string): void {
  reports.delete(threadId);
}
