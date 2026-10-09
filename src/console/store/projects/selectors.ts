import { createSelector } from 'reselect';
import type { ProjectView } from '../../../api/contract.ts';
import type { State } from '../types.ts';

export const selectProjectsState = (state: State) => state.projects;
export const selectProjects = createSelector([selectProjectsState], projects =>
  projects.ids.map(id => projects.byId[id]).filter((project): project is ProjectView => project !== undefined),
);
export const selectProjectBySlug = (state: State, slug: string) => selectProjects(state).find(project => project.slug === slug);

// Projects in work, the most recently touched first; archived ones aside.
export const selectActiveProjects = createSelector([selectProjects], projects =>
  projects.filter(project => !project.archived).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
);
export const selectArchivedProjectCount = (state: State) => selectProjects(state).filter(project => project.archived).length;
