// The apps: the snapshot's listing (every app folder of the file area with
// its publication), then app.published / app.unpublished of the tail flip
// the slug of the folder's row. A folder the listing does not know yet (an
// app written after the snapshot) joins with the identity the event carries
// (the manifest is valid at publish time); its later changes and new
// folders need the next snapshot (plan.md, «Чего нет в данных»).

import type { AppListingView } from '../../../api/contract.ts';
import type { Action } from '../types.ts';

export type AppsState = { items: AppListingView[]; publicAppsBase: string };

export function appsReducer(state: AppsState = { items: [], publicAppsBase: '' }, action: Action): AppsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { items: action.snapshot.apps.apps, publicAppsBase: action.snapshot.apps.publicAppsBase };
    case 'event/app.published': {
      const { path, slug, name, description } = action.event.payload;

      if (!path || !slug) {
        return state;
      }

      const known = state.items.find(item => item.path === path);

      if (known) {
        return known.slug === slug ? state : { ...state, items: state.items.map(item => (item === known ? { ...item, slug } : item)) };
      }

      const items = [...state.items, { path, slug, name: name ?? null, description: description ?? null, manifestError: null }].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      return { ...state, items };
    }
    case 'event/app.unpublished': {
      const { path } = action.event.payload;
      const known = state.items.find(item => item.path === path);

      return known && known.slug !== null ? { ...state, items: state.items.map(item => (item === known ? { ...item, slug: null } : item)) } : state;
    }
    default:
      return state;
  }
}
