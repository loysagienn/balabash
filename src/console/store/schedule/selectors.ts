import { createSelector } from 'reselect';
import type { TaskView } from '../../../api/contract.ts';
import type { State } from '../types.ts';
import { ownCall } from './reducer.ts';
import type { TaskCall } from './reducer.ts';

export const selectScheduleState = (state: State) => state.schedule;

// The tasks in the snapshot's order (oldest first).
export const selectTasks = createSelector([selectScheduleState], schedule => schedule.ids.map(id => schedule.tasks[id]).filter((task): task is TaskView => task !== undefined));

export const selectTaskBySlug = (state: State, slug: string): TaskView | null => selectTasks(state).find(task => task.slug === slug) ?? null;

export const selectTaskCall = (state: State, slug: string): TaskCall | null => ownCall(state.schedule.calls, slug) ?? null;

export const selectRunsChanged = (state: State) => state.schedule.runsChanged;
