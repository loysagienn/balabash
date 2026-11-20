// The toasts of the schedule's commands, in the task's own words. Pure.

import type { CreateTaskResponse } from '../../../api/contract.ts';
import type { RunTaskResponse } from '../../../api/contract.ts';
import type { ToastInput } from '../ui/actions.ts';

export function runOutcomeWords(name: string, kind: string, outcome: RunTaskResponse): ToastInput {
  if (outcome.outcome === 'already_running') {
    return { title: 'Already running', desc: `“${name}” — a run is still going, this one is skipped.`, state: 'wait' };
  }

  if (kind === 'note') {
    return { title: 'Reminder sent', desc: `“${name}” landed in the main thread.`, state: 'done' };
  }

  return { title: 'Run started', desc: `“${name}” — the outcome lands in its runs.`, state: 'run' };
}

export function deletedWords(name: string): ToastInput {
  return { title: 'Task deleted', desc: `“${name}” will no longer run. Its run log stays.`, state: 'off' };
}

export function createdWords({ task }: CreateTaskResponse): ToastInput {
  if (task.kind === 'note') {
    return { title: 'Reminder created', desc: task.nextRunAt ? `“${task.name}” lands in the main thread at its moment.` : `“${task.name}” lands in the main thread on a manual run.`, state: 'done' };
  }

  return { title: 'Task created', desc: task.nextRunAt ? `“${task.name}” is armed; every run lands in its runs.` : `“${task.name}” runs on “Run now” only; every run lands in its runs.`, state: 'done' };
}
