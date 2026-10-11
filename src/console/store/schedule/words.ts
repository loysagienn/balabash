// The toasts of the schedule's commands, in the task's own words. Pure.

import type { CreateTaskResponse } from '../../../api/contract.ts';
import type { RunTaskResponse } from '../../../api/contract.ts';
import type { ToastInput } from '../ui/actions.ts';

// A manual run accepted: what happens next depends on the kind — a command
// job's run is in its journal, a note is in the main thread, a code task
// speaks only through its events; a run still going burns this one.
export function runOutcomeWords(name: string, kind: string, outcome: RunTaskResponse): ToastInput {
  if (outcome.outcome === 'already_running') {
    return { title: 'Already running', desc: `“${name}” — a run is still going, this one is skipped.`, state: 'wait' };
  }

  if (kind === 'note') {
    return { title: 'Reminder sent', desc: `“${name}” landed in the main thread.`, state: 'done' };
  }

  if (kind === 'code') {
    return { title: 'Task started', desc: `“${name}” reports through its events; a failure shows in the bell.`, state: 'run' };
  }

  return { title: 'Run started', desc: `“${name}” — the outcome lands in its runs.`, state: 'run' };
}

export function deletedWords(name: string): ToastInput {
  return { title: 'Task deleted', desc: `“${name}” will no longer run. Its run log stays.`, state: 'off' };
}

// A task registered: a command job is armed at once, a reminder waits for
// its moment, a code task without a body sleeps until an agent writes one
// — the words say what happens next, the row says when.
export function createdWords({ task, sleeping }: CreateTaskResponse): ToastInput {
  if (task.kind === 'code' && sleeping) {
    return { title: 'Task created — sleeping', desc: `“${task.name}” has no body yet: it sleeps until an agent writes tasks/${task.slug}.ts.`, state: 'wait' };
  }

  if (task.kind === 'note') {
    return { title: 'Reminder created', desc: task.nextRunAt ? `“${task.name}” lands in the main thread at its moment.` : `“${task.name}” lands in the main thread on a manual run.`, state: 'done' };
  }

  if (task.kind === 'code') {
    return { title: 'Task created', desc: `“${task.name}” runs its body at its moment and reports through its events.`, state: 'done' };
  }

  return { title: 'Task created', desc: task.nextRunAt ? `“${task.name}” is armed; every run lands in its runs.` : `“${task.name}” runs on “Run now” only; every run lands in its runs.`, state: 'done' };
}
