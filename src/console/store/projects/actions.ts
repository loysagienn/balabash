// The operator's changes to the project registry (stage 6b endpoints): a
// new project, its title and description, the archive flag. The answer
// carries the row as the snapshot has it and is folded at once; the same
// change comes back as a project.* event of the tail, idempotently.

import type { CreateProjectRequest, ProjectView, UpdateProjectRequest } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export const createProject = (input: CreateProjectRequest) => ({ type: 'CREATE_PROJECT', input }) as const;
// adopted — the folder already existed in the file area and became the library.
export const createProjectDone = (input: CreateProjectRequest, project: ProjectView, adopted: boolean) => ({ type: 'CREATE_PROJECT_DONE', input, project, adopted }) as const;
export const createProjectFail = (input: CreateProjectRequest, error: ApiFailure) => ({ type: 'CREATE_PROJECT_FAIL', input, error }) as const;

export const updateProject = (id: string, patch: UpdateProjectRequest) => ({ type: 'UPDATE_PROJECT', id, patch }) as const;
export const updateProjectDone = (id: string, project: ProjectView) => ({ type: 'UPDATE_PROJECT_DONE', id, project }) as const;
export const updateProjectFail = (id: string, error: ApiFailure) => ({ type: 'UPDATE_PROJECT_FAIL', id, error }) as const;

export const setProjectArchived = (id: string, archived: boolean) => ({ type: 'SET_PROJECT_ARCHIVED', id, archived }) as const;
export const setProjectArchivedDone = (id: string, project: ProjectView) => ({ type: 'SET_PROJECT_ARCHIVED_DONE', id, project }) as const;
export const setProjectArchivedFail = (id: string, archived: boolean, error: ApiFailure) => ({ type: 'SET_PROJECT_ARCHIVED_FAIL', id, archived, error }) as const;
