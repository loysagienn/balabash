// The scheduled tasks: the snapshot's list, then schedule.task.created adds
// the row the event carries and schedule.task.cancelled (a cancel, or a
// one-shot consumed by its fire) drops it; the operator's own delete drops
// it at once (DELETE_TASK_DONE), the tail's event then finds nothing to do.
// nextRunAt of a cron task is the moment computed when the row was read or
// created — after a fire it is stale until the next snapshot; the screen
// recomputes it from the expression in the schedule's time zone
// (screens/schedule/nextRun.ts). calls — by slug, the operator's call in
// flight (a run or a delete), one per task at a time, applied by identity.
// create — the "New task" form (lib/forms/attempt.ts): the call in flight,
// the refusal the form shows, how many creations the server accepted.
// overtaken — what the store learned while that call was in flight: the
// tasks the tail (or the operator's delete) dropped and whether a snapshot
// replaced the list. The tail may bring the created row and its end (a
// cancel from elsewhere, a past one-off consumed by its fire) before the
// answer: the answer's row is folded only when nothing newer could have
// spoken of it — a dropped id is not brought back, and after a snapshot the
// snapshot and its tail say whether the row lives.
// runsChanged — a stamp of the run journal (job_runs, read by place): it
// moves when a manual run of a command job was accepted (RUN_TASK_DONE
// with a runId), when a job reported through the log (schedule.fired with
// a runId — a success asked to report, system.exception of a workspace job
// — a failure); the process lib/query/schedule.ts re-reads the journal's
// queries on it. A silent success writes no event: the screen polls while a
// run is going (screens/schedule/queries.ts).

import type { TaskView } from '../../../api/contract.ts';
import type { FormCallState } from '../../lib/forms/attempt.ts';
import { idleForm } from '../../lib/forms/attempt.ts';
import { taskFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type TaskCall = { kind: 'run' } | { kind: 'delete' };

export type CreateOvertaken = { dropped: string[]; reloaded: boolean };

export type ScheduleState = {
  tasks: Record<string, TaskView>;
  ids: string[];
  calls: Record<string, TaskCall>;
  create: FormCallState;
  overtaken: CreateOvertaken | null;
  runsChanged: number;
};

export const initialSchedule: ScheduleState = { tasks: {}, ids: [], calls: {}, create: idleForm, overtaken: null, runsChanged: 0 };

function withTask(state: ScheduleState, task: TaskView): ScheduleState {
  return { ...state, tasks: { ...state.tasks, [task.id]: task }, ids: state.ids.includes(task.id) ? state.ids : [...state.ids, task.id] };
}

// The call in flight for a slug — read by own key: a slug could be named
// like a key of Object.prototype.
export function ownCall(calls: Record<string, TaskCall>, slug: string): TaskCall | undefined {
  return Object.hasOwn(calls, slug) ? calls[slug] : undefined;
}

function withoutCall(state: ScheduleState, slug: string, request: TaskCall): ScheduleState {
  if (ownCall(state.calls, slug) !== request) {
    return state;
  }

  const { [slug]: dropped, ...calls } = state.calls;

  return { ...state, calls };
}

// A task dropped: the row goes, and a creation in flight remembers the id —
// even one the store never held (its created event may still be ahead of
// the answer, or the row came and went before it).
function withoutTask(state: ScheduleState, id: string | undefined): ScheduleState {
  if (!id) {
    return state;
  }

  const remembered = state.overtaken && !state.overtaken.dropped.includes(id) ? { ...state, overtaken: { ...state.overtaken, dropped: [...state.overtaken.dropped, id] } } : state;

  if (!remembered.tasks[id]) {
    return remembered;
  }

  const { [id]: dropped, ...tasks } = remembered.tasks;

  return { ...remembered, tasks, ids: remembered.ids.filter(known => known !== id) };
}

// The answer's row, unless the store heard newer of it while the call was
// in flight (overtaken above).
function withCreated(state: ScheduleState, task: TaskView, overtaken: CreateOvertaken | null): ScheduleState {
  if (overtaken && (overtaken.reloaded || overtaken.dropped.includes(task.id))) {
    return state;
  }

  return withTask(state, task);
}

export function scheduleReducer(state: ScheduleState = initialSchedule, action: Action): ScheduleState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const tasks: Record<string, TaskView> = {};

      for (const task of action.snapshot.tasks) {
        tasks[task.id] = task;
      }

      return { ...state, tasks, ids: action.snapshot.tasks.map(task => task.id), overtaken: state.overtaken ? { ...state.overtaken, reloaded: true } : null };
    }
    case 'event/schedule.task.created': {
      const task = taskFromRecord(action.event.payload);

      return task ? withTask(state, task) : state;
    }
    case 'CREATE_TASK':
      return { ...state, create: { ...state.create, pending: true, error: null }, overtaken: { dropped: [], reloaded: false } };
    case 'CREATE_TASK_DONE':
      return state.create === action.request ? withCreated({ ...state, create: { pending: false, error: null, done: state.create.done + 1 }, overtaken: null }, action.created.task, state.overtaken) : state;
    case 'CREATE_TASK_FAIL':
      return state.create === action.request ? { ...state, create: { ...state.create, pending: false, error: action.error }, overtaken: null } : state;
    case 'event/schedule.task.cancelled':
      return withoutTask(state, action.event.payload.id);
    case 'event/schedule.fired':
      return action.event.payload.runId ? { ...state, runsChanged: state.runsChanged + 1 } : state;
    case 'event/system.exception':
      return action.event.payload.scope === 'workspace-job' ? { ...state, runsChanged: state.runsChanged + 1 } : state;
    case 'RUN_TASK':
      return ownCall(state.calls, action.slug) ? state : { ...state, calls: { ...state.calls, [action.slug]: { kind: 'run' } } };
    case 'DELETE_TASK':
      return ownCall(state.calls, action.slug) ? state : { ...state, calls: { ...state.calls, [action.slug]: { kind: 'delete' } } };
    case 'RUN_TASK_DONE': {
      if (ownCall(state.calls, action.slug) !== action.request) {
        return state;
      }

      const freed = withoutCall(state, action.slug, action.request);

      return action.outcome.runId ? { ...freed, runsChanged: freed.runsChanged + 1 } : freed;
    }
    case 'DELETE_TASK_DONE': {
      if (ownCall(state.calls, action.slug) !== action.request) {
        return state;
      }

      return withoutTask(withoutCall(state, action.slug, action.request), action.deleted.task.id);
    }
    case 'RUN_TASK_FAIL':
    case 'DELETE_TASK_FAIL':
      return withoutCall(state, action.slug, action.request);
    default:
      return state;
  }
}
