// The scheduled tasks: the snapshot's list, then schedule.task.created adds
// the row the event carries and schedule.task.cancelled (a cancel, or a
// one-shot consumed by its fire) drops it. nextRunAt of a cron task is the
// moment computed when the row was read or created — after a fire it is
// stale until the next snapshot (plan.md, «Чего нет в данных»).

import type { TaskView } from '../../../api/contract.ts';
import { taskFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type ScheduleState = { tasks: Record<string, TaskView>; ids: string[] };

export function scheduleReducer(state: ScheduleState = { tasks: {}, ids: [] }, action: Action): ScheduleState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const tasks: Record<string, TaskView> = {};

      for (const task of action.snapshot.tasks) {
        tasks[task.id] = task;
      }

      return { tasks, ids: action.snapshot.tasks.map(task => task.id) };
    }
    case 'event/schedule.task.created': {
      const task = taskFromRecord(action.event.payload);

      if (!task) {
        return state;
      }

      return { tasks: { ...state.tasks, [task.id]: task }, ids: state.ids.includes(task.id) ? state.ids : [...state.ids, task.id] };
    }
    case 'event/schedule.task.cancelled': {
      const { id } = action.event.payload;

      if (!id || !state.tasks[id]) {
        return state;
      }

      const { [id]: dropped, ...tasks } = state.tasks;

      return { tasks, ids: state.ids.filter(known => known !== id) };
    }
    default:
      return state;
  }
}
