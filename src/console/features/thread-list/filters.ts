// The Threads route as a filter set: a change produces the next route (an
// undefined value drops the key, so the URL stays canonical), and a route
// with any filter set is "filtered" — the empty state offers to reset it.

import type { ThreadsRoute } from '../../lib/router/routes.ts';

export type ThreadsFilterPatch = Partial<Omit<ThreadsRoute, 'key'>>;

export function withFilters(route: ThreadsRoute, patch: ThreadsFilterPatch): ThreadsRoute {
  const next: ThreadsRoute = { ...route, ...patch };

  for (const key of ['status', 'agent', 'project', 'q'] as const) {
    if (next[key] === undefined || next[key] === '') {
      delete next[key];
    }
  }

  return next;
}

export function hasFilters(route: ThreadsRoute): boolean {
  return Boolean(route.status || route.agent || route.project || route.q);
}
