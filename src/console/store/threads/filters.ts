// The filters of the threads list as the server understands them — the
// identity of a loaded page set: status and project (the route names a
// project by slug, the request needs its id, from the snapshot's projects).
// The route's agent and q narrow the loaded rows in the browser
// (store/threads/selectors.ts); they do not reload the list.

import type { ThreadStatus } from '../../../core/contract.ts';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import type { ProjectsState } from '../projects/reducer.ts';

export type ThreadsListFilters = {
  status: ThreadStatus | null;
  projectId: string | null;
};

export function threadsFiltersOf(route: ThreadsRoute, projects: ProjectsState): ThreadsListFilters {
  const project = route.project ? projects.ids.map(id => projects.byId[id]).find(p => p?.slug === route.project) : undefined;

  return {
    status: route.status ?? null,
    projectId: project?.id ?? null,
  };
}

export function sameFilters(a: ThreadsListFilters | null, b: ThreadsListFilters | null): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return a.status === b.status && a.projectId === b.projectId;
}
