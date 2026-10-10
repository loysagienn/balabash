// The scheduled tasks: the snapshot's list, then schedule.task.created adds
// the row the event carries and schedule.task.cancelled (a cancel, or a
// one-shot consumed by its fire) drops it; the operator's own delete drops
// it at once (DELETE_TASK_DONE), the tail's event then finds nothing to do.
// nextRunAt of a cron task is the moment computed when the row was read or
// created — after a fire it is stale until the next snapshot; the screen
// recomputes it from the expression in the schedule's time zone
// (screens/schedule/nextRun.ts). calls — by slug, the operator's call in
// flight (a run or a delete), one per task at a time, applied by identity.
// runsChanged — a stamp of the run journal (job_runs, read by place): it
// moves when a manual run of a command job was accepted (RUN_TASK_DONE
// with a runId), when a job reported through the log (schedule.fired with
// a runId — a success asked to report, system.exception of a workspace job
// — a failure); the process lib/query/schedule.ts re-reads the journal's
// queries on it. A silent success writes no event: the screen polls while a
// run is going (screens/schedule/queries.ts).

import type { TaskView } from '../../../api/contract.ts';
import { taskFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type TaskCall = { kind: 'run' } | { kind: 'delete' };

export type ScheduleState = {
  tasks: Record<string, TaskView>;
  ids: string[];
  calls: Record<string, TaskCall>;
  runsChanged: number;
};

export const initialSchedule: ScheduleState = { tasks: {}, ids: [], calls: {}, runsChanged: 0 };

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

function withoutTask(state: ScheduleState, id: string | undefined): ScheduleState {
  if (!id || !state.tasks[id]) {
    return state;
  }

  const { [id]: dropped, ...tasks } = state.tasks;

  return { ...state, tasks, ids: state.ids.filter(known => known !== id) };
}

export function scheduleReducer(state: ScheduleState = initialSchedule, action: Action): ScheduleState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const tasks: Record<string, TaskView> = {};

      for (const task of action.snapshot.tasks) {
        tasks[task.id] = task;
      }

      return { ...state, tasks, ids: action.snapshot.tasks.map(task => task.id) };
    }
    case 'event/schedule.task.created': {
      const task = taskFromRecord(action.event.payload);

      if (!task) {
        return state;
      }

      return { ...state, tasks: { ...state.tasks, [task.id]: task }, ids: state.ids.includes(task.id) ? state.ids : [...state.ids, task.id] };
    }
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
