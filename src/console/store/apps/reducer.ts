// The apps: the snapshot's listing (every app folder of the file area with
// its publication), then app.published / app.unpublished of the tail keep
// the folder's row. A publication carries the manifest as validated at
// publish time — name and description — so the row takes them and drops
// any manifest error the snapshot knew (the manifest was fixed before the
// publish could succeed); a folder the listing does not know yet (an app
// written after the snapshot) joins with that identity. Other manifest
// edits and new unpublished folders need the next snapshot (plan.md, «Чего
// нет в данных»).

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

      const row: AppListingView = { path, slug, name: name ?? null, description: description ?? null, manifestError: null };
      const known = state.items.find(item => item.path === path);

      if (known) {
        const same = known.slug === row.slug && known.name === row.name && known.description === row.description && known.manifestError === null;

        return same ? state : { ...state, items: state.items.map(item => (item === known ? row : item)) };
      }

      const items = [...state.items, row].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

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
