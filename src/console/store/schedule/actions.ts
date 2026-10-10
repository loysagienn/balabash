import type { DeleteTaskResponse, RunTaskResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { TaskCall } from './reducer.ts';

// The operator's commands over a task from the Schedule screen (POST
// /api/schedule/tasks/:slug/run, DELETE /api/schedule/tasks/:slug). One
// call per task at a time — the call in flight is schedule.calls[slug], and
// the outcome names it (`request`): the reducer applies an outcome only
// while the store still waits for exactly that call. A run's outcome is a
// toast (the journal row of a command job is read by place, a note lands
// in the main thread's feed); a delete drops the row at once — the same end
// comes back as schedule.task.cancelled of the tail, idempotently.
export const runTask = (slug: string) => ({ type: 'RUN_TASK', slug }) as const;
export const runTaskDone = (slug: string, request: TaskCall, outcome: RunTaskResponse) => ({ type: 'RUN_TASK_DONE', slug, request, outcome }) as const;
export const runTaskFail = (slug: string, request: TaskCall, error: ApiFailure) => ({ type: 'RUN_TASK_FAIL', slug, request, error }) as const;
export const deleteTask = (slug: string) => ({ type: 'DELETE_TASK', slug }) as const;
export const deleteTaskDone = (slug: string, request: TaskCall, deleted: DeleteTaskResponse) => ({ type: 'DELETE_TASK_DONE', slug, request, deleted }) as const;
export const deleteTaskFail = (slug: string, request: TaskCall, error: ApiFailure) => ({ type: 'DELETE_TASK_FAIL', slug, request, error }) as const;
