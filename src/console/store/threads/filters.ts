// The filters of the threads list as the server understands them — the
// identity of a loaded page set: status, project (the route names a project
// by slug, the request needs its id, from the snapshot's projects), agent
// and the search text. The same rules, read in the browser (matchesFilters),
// decide which threads of the store belong to the loaded range — so a
// thread the tail starts or finishes finds its place without a reload.

import type { Thread, ThreadStatus } from '../../../core/contract.ts';
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
    q: route.q?.trim() || null,
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

// The text of a thread the search looks through: title, description,
// summary — case-insensitive, as the server's ILIKE reads it.
export function threadMatches(thread: Thread, q: string): boolean {
  const needle = q.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return [thread.title, thread.description, thread.summary?.text].some(text => text?.toLowerCase().includes(needle));
}

// Whether a thread belongs to the set the filters describe, status aside:
// the set the per-status counts are taken over.
export function inFilterSet(thread: Thread, filters: ThreadsListFilters): boolean {
  return (filters.projectId === null || thread.projectId === filters.projectId) && (filters.agent === null || thread.agent === filters.agent) && (filters.q === null || threadMatches(thread, filters.q));
}

export function matchesFilters(thread: Thread, filters: ThreadsListFilters): boolean {
  return (filters.status === null || thread.status === filters.status) && inFilterSet(thread, filters);
}
