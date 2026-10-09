import { createSelector } from 'reselect';
import type { ProjectView } from '../../../api/contract.ts';
import type { State } from '../types.ts';

export const selectProjectsState = (state: State) => state.projects;
export const selectProjects = createSelector([selectProjectsState], projects =>
  projects.ids.map(id => projects.byId[id]).filter((project): project is ProjectView => project !== undefined),
);
export const selectProjectBySlug = (state: State, slug: string) => selectProjects(state).find(project => project.slug === slug);
