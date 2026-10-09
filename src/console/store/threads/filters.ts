// The filters of the threads list as the server understands them: the
// route names a project by slug, the request needs its id (from the
// snapshot's projects). q and agent are kept for the screen (client-side
// until the server filters by them).

import type { ThreadStatus } from '../../../core/contract.ts';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import type { ProjectsState } from '../projects/reducer.ts';

export type ThreadsListFilters = {
  status: ThreadStatus | null;
  projectId: string | null;
  agent: string | null;
  q: string | null;
};

export function threadsFiltersOf(route: ThreadsRoute, projects: ProjectsState): ThreadsListFilters {
  const project = route.project ? projects.ids.map(id => projects.byId[id]).find(p => p?.slug === route.project) : undefined;

  return {
    status: route.status ?? null,
    projectId: project?.id ?? null,
    agent: route.agent ?? null,
    q: route.q ?? null,
  };
}

export function sameFilters(a: ThreadsListFilters | null, b: ThreadsListFilters | null): boolean {
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  return a.status === b.status && a.projectId === b.projectId && a.agent === b.agent && a.q === b.q;
}
