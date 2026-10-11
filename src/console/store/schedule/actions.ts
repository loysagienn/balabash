import type { CreateTaskRequest, CreateTaskResponse, DeleteTaskResponse, RunTaskResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { FormCallState } from '../../lib/forms/attempt.ts';
import type { TaskCall } from './reducer.ts';

// The operator's commands over the tasks from the Schedule screen. A new
// task (POST /api/schedule/tasks) is a form (lib/forms/attempt.ts): one
// call at a time, its refusal held for the form to show under the field
// it names, the accepted count moved when the row came back — the row is
// folded at once (the tail's schedule.task.created finds it there) and the
// outcome names the form state it answers (`request`), so an answer that
// outlived its session touches nothing. The run and the delete (POST
// /api/schedule/tasks/:slug/run, DELETE /api/schedule/tasks/:slug): one
// call per task at a time — the call in flight is schedule.calls[slug], and
// the outcome names it (`request`): the reducer applies an outcome only
// while the store still waits for exactly that call. A run's outcome is a
// toast (the journal row of a command job is read by place, a note lands
// in the main thread's feed); a delete drops the row at once — the same end
// comes back as schedule.task.cancelled of the tail, idempotently. `id` —
// the row the operator saw: the server refuses the command when the slug
// belongs to another row by then (409 task_replaced), so a card never
// runs or deletes a task it did not show.
export const runTask = (slug: string, id: string) => ({ type: 'RUN_TASK', slug, id }) as const;
export const runTaskDone = (slug: string, request: TaskCall, outcome: RunTaskResponse) => ({ type: 'RUN_TASK_DONE', slug, request, outcome }) as const;
export const runTaskFail = (slug: string, request: TaskCall, error: ApiFailure) => ({ type: 'RUN_TASK_FAIL', slug, request, error }) as const;
export const deleteTask = (slug: string, id: string) => ({ type: 'DELETE_TASK', slug, id }) as const;
export const deleteTaskDone = (slug: string, request: TaskCall, deleted: DeleteTaskResponse) => ({ type: 'DELETE_TASK_DONE', slug, request, deleted }) as const;
export const deleteTaskFail = (slug: string, request: TaskCall, error: ApiFailure) => ({ type: 'DELETE_TASK_FAIL', slug, request, error }) as const;
export const createTask = (input: CreateTaskRequest) => ({ type: 'CREATE_TASK', input }) as const;
export const createTaskDone = (request: FormCallState, created: CreateTaskResponse) => ({ type: 'CREATE_TASK_DONE', request, created }) as const;
export const createTaskFail = (request: FormCallState, error: ApiFailure) => ({ type: 'CREATE_TASK_FAIL', request, error }) as const;
