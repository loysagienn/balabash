// The project registry: the snapshot's list, then every project.* event
// of the tail upserts the row it carries (the server writes them where the
// table changes — src/core/registry-events.ts). Idempotent: the same row
// folded twice is the same state.

import type { ProjectView } from '../../../api/contract.ts';
import { projectFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type ProjectsState = { byId: Record<string, ProjectView>; ids: string[] };

function upsert(state: ProjectsState, project: ProjectView): ProjectsState {
  return {
    byId: { ...state.byId, [project.id]: project },
    ids: state.ids.includes(project.id) ? state.ids : [...state.ids, project.id],
  };
}

export function projectsReducer(state: ProjectsState = { byId: {}, ids: [] }, action: Action): ProjectsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ProjectView> = {};

      for (const project of action.snapshot.projects) {
        byId[project.id] = project;
      }

      return { byId, ids: action.snapshot.projects.map(project => project.id) };
    }
    case 'event/project.created':
    case 'event/project.updated':
    case 'event/project.archived':
    case 'event/project.unarchived': {
      const project = projectFromRecord(action.event.payload);

      return project ? upsert(state, project) : state;
    }
    default:
      return state;
  }
}
