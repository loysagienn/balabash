import { createSelector } from 'reselect';
import type { ProjectView } from '../../../api/contract.ts';
import type { State } from '../types.ts';
import { idleForm } from './reducer.ts';
import type { ProjectFormState } from './reducer.ts';

export const selectProjectsState = (state: State) => state.projects;
export const selectProjects = createSelector([selectProjectsState], projects =>
  projects.ids.map(id => projects.byId[id]).filter((project): project is ProjectView => project !== undefined),
);
export const selectProjectBySlug = (state: State, slug: string) => selectProjects(state).find(project => project.slug === slug);

const recentFirst = (a: ProjectView, b: ProjectView) => b.updatedAt.getTime() - a.updatedAt.getTime();

// Projects in work, the most recently touched first; archived ones aside.
export const selectActiveProjects = createSelector([selectProjects], projects => projects.filter(project => !project.archived).sort(recentFirst));
export const selectArchivedProjects = createSelector([selectProjects], projects => projects.filter(project => project.archived).sort(recentFirst));
export const selectArchivedProjectCount = (state: State) => selectArchivedProjects(state).length;

// The forms of the registry's changes.
export const selectProjectCreate = (state: State): ProjectFormState => state.projects.create;
export const selectProjectEdit = (state: State, id: string): ProjectFormState => state.projects.edit[id] ?? idleForm;
export const selectProjectFlagging = (state: State, id: string): boolean => state.projects.flagging[id] === true;
