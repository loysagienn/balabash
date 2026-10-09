// The rules of the Apps screen: the counts of the segments, the search,
// the rows under the route's filter and the next route of a filter change.
// Pure, tested. Where a row leads — features/apps/appLink.ts.

import type { AppListingView } from '../../../api/contract.ts';
import type { AppsFilter, AppsRoute } from '../../lib/router/routes.ts';

export type AppsCounts = { all: number; published: number; errors: number };

export function appsCounts(apps: Pick<AppListingView, 'slug' | 'manifestError'>[]): AppsCounts {
  return {
    all: apps.length,
    published: apps.filter(app => app.slug !== null).length,
    errors: apps.filter(app => app.manifestError !== null).length,
  };
}

// The search looks through the name, the description and the folder.
export function appMatches(app: Pick<AppListingView, 'name' | 'description' | 'path'>, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return [app.name, app.description, app.path].some(text => text?.toLowerCase().includes(needle));
}

export function appInFilter(app: Pick<AppListingView, 'slug' | 'manifestError'>, filter: AppsFilter | undefined): boolean {
  switch (filter) {
    case 'published':
      return app.slug !== null;
    case 'errors':
      return app.manifestError !== null;
    default:
      return true;
  }
}

export function visibleApps<A extends Pick<AppListingView, 'name' | 'description' | 'path' | 'slug' | 'manifestError'>>(apps: A[], route: AppsRoute): A[] {
  return apps.filter(app => appInFilter(app, route.filter) && appMatches(app, route.q));
}

export type AppsFilterPatch = Partial<Omit<AppsRoute, 'key'>>;

// The next route of a change: an undefined or empty value drops the key, so
// the URL stays canonical.
export function withAppsFilters(route: AppsRoute, patch: AppsFilterPatch): AppsRoute {
  const next: AppsRoute = { ...route, ...patch };

  for (const key of ['filter', 'q'] as const) {
    if (next[key] === undefined || next[key] === '') {
      delete next[key];
    }
  }

  return next;
}

export function hasAppsFilters(route: AppsRoute): boolean {
  return Boolean(route.filter || route.q);
}
