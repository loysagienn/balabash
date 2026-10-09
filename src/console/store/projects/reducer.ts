// The project registry from the snapshot; project.* events join when the
// server writes them (plan, stage 6).

import type { ProjectView } from '../../../api/contract.ts';
import type { Action } from '../types.ts';

export type ProjectsState = { byId: Record<string, ProjectView>; ids: string[] };

export function projectsReducer(state: ProjectsState = { byId: {}, ids: [] }, action: Action): ProjectsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ProjectView> = {};

      for (const project of action.snapshot.projects) {
        byId[project.id] = project;
      }

      return { byId, ids: action.snapshot.projects.map(project => project.id) };
    }
    default:
      return state;
  }
}
