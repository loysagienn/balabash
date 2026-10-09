// The project registry: the snapshot's list, then every project.* event
// of the tail upserts the row it carries (the server writes them where the
// table changes — src/core/registry-events.ts), and the answer of the
// operator's own change does the same at once. Idempotent: the same row
// folded twice is the same state. Beside the rows — the state of the forms
// that change the registry (the "New project" and "Edit project" dialogs)
// and the archive flips in flight.

import type { ProjectView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import { projectFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

// A form's call: in flight, the failure of the last call (the dialog shows
// it), how many calls the server accepted (the dialog closes when the
// count moves).
export type ProjectFormState = { pending: boolean; error: ApiFailure | null; done: number };

export type ProjectsState = {
  byId: Record<string, ProjectView>;
  ids: string[];
  create: ProjectFormState;
  // By project id: the "Edit project" form of each.
  edit: Record<string, ProjectFormState>;
  // Project ids whose archive flag is on its way.
  flagging: Record<string, true>;
};

export const idleForm: ProjectFormState = { pending: false, error: null, done: 0 };

export const initialProjects: ProjectsState = { byId: {}, ids: [], create: idleForm, edit: {}, flagging: {} };

function upsert(state: ProjectsState, project: ProjectView): ProjectsState {
  return {
    ...state,
    byId: { ...state.byId, [project.id]: project },
    ids: state.ids.includes(project.id) ? state.ids : [...state.ids, project.id],
  };
}

function withEdit(state: ProjectsState, id: string, form: (current: ProjectFormState) => ProjectFormState): ProjectsState {
  return { ...state, edit: { ...state.edit, [id]: form(state.edit[id] ?? idleForm) } };
}

function withFlagging(state: ProjectsState, id: string, pending: boolean): ProjectsState {
  if (pending) {
    return { ...state, flagging: { ...state.flagging, [id]: true } };
  }

  const { [id]: dropped, ...rest } = state.flagging;

  return dropped ? { ...state, flagging: rest } : state;
}

export function projectsReducer(state: ProjectsState = initialProjects, action: Action): ProjectsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ProjectView> = {};

      for (const project of action.snapshot.projects) {
        byId[project.id] = project;
      }

      return { ...state, byId, ids: action.snapshot.projects.map(project => project.id) };
    }
    case 'event/project.created':
    case 'event/project.updated':
    case 'event/project.archived':
    case 'event/project.unarchived': {
      const project = projectFromRecord(action.event.payload);

      return project ? upsert(state, project) : state;
    }
    case 'CREATE_PROJECT':
      return { ...state, create: { ...state.create, pending: true, error: null } };
    case 'CREATE_PROJECT_DONE':
      return upsert({ ...state, create: { pending: false, error: null, done: state.create.done + 1 } }, action.project);
    case 'CREATE_PROJECT_FAIL':
      return { ...state, create: { ...state.create, pending: false, error: action.error } };
    case 'UPDATE_PROJECT':
      return withEdit(state, action.id, form => ({ ...form, pending: true, error: null }));
    case 'UPDATE_PROJECT_DONE':
      return upsert(
        withEdit(state, action.id, form => ({ pending: false, error: null, done: form.done + 1 })),
        action.project,
      );
    case 'UPDATE_PROJECT_FAIL':
      return withEdit(state, action.id, form => ({ ...form, pending: false, error: action.error }));
    case 'SET_PROJECT_ARCHIVED':
      return withFlagging(state, action.id, true);
    case 'SET_PROJECT_ARCHIVED_DONE':
      return upsert(withFlagging(state, action.id, false), action.project);
    case 'SET_PROJECT_ARCHIVED_FAIL':
      return withFlagging(state, action.id, false);
    default:
      return state;
  }
}
