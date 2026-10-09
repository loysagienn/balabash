import type { TaskView } from '../../../api/contract.ts';
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
    default:
      return state;
  }
}
