// The apps: the snapshot's listing (every app folder of the file area with
// its publication), then app.published / app.unpublished of the tail keep
// the folder's row, and the listing read again (LOAD_APPS — the Apps screen
// opened, the tab back in view, a Retry) replaces the rows: a folder written
// after the snapshot or a manifest edited since has no event, only the
// listing knows it. A publication carries the manifest as validated at
// publish time — name and description — so the row takes them and drops
// any manifest error the snapshot knew (the manifest was fixed before the
// publish could succeed); a folder the listing does not know yet joins with
// that identity. eventSeq — the seq of the last app.* event that changed the
// rows: a listing requested before it may predate it and is not applied
// (store/apps/handlers.ts asks again).

import type { AppListingView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';

export type AppsState = {
  items: AppListingView[];
  publicAppsBase: string;
  eventSeq: bigint | null;
  refresh: { pending: boolean; error: ApiFailure | null };
};

export const initialApps: AppsState = { items: [], publicAppsBase: '', eventSeq: null, refresh: { pending: false, error: null } };

const byPath = (a: AppListingView, b: AppListingView) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function sameRow(a: AppListingView, b: AppListingView): boolean {
  return a.path === b.path && a.slug === b.slug && a.name === b.name && a.description === b.description && a.manifestError === b.manifestError;
}

// The same rows in the same order: a listing that changed nothing is no
// change of state (the screen keeps its elements).
export function sameListing(a: AppListingView[], b: AppListingView[]): boolean {
  return a.length === b.length && a.every((row, i) => sameRow(row, b[i]));
}

export function appsReducer(state: AppsState = initialApps, action: Action): AppsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, items: action.snapshot.apps.apps, publicAppsBase: action.snapshot.apps.publicAppsBase };
    case 'LOAD_APPS':
      return { ...state, refresh: { pending: true, error: null } };
    case 'LOAD_APPS_DONE': {
      const refresh = { pending: false, error: null };

      if (action.since !== state.eventSeq) {
        return { ...state, refresh };
      }

      const items = sameListing(state.items, action.apps.apps) ? state.items : action.apps.apps;

      return { ...state, items, publicAppsBase: action.apps.publicAppsBase, refresh };
    }
    case 'LOAD_APPS_FAIL':
      return { ...state, refresh: { pending: false, error: action.error } };
    case 'event/app.published': {
      const { path, slug, name, description } = action.event.payload;

      if (!path || !slug) {
        return state;
      }

      const row: AppListingView = { path, slug, name: name ?? null, description: description ?? null, manifestError: null };
      const known = state.items.find(item => item.path === path);

      if (known) {
        return sameRow(known, row) ? state : { ...state, items: state.items.map(item => (item === known ? row : item)), eventSeq: action.event.seq };
      }

      return { ...state, items: [...state.items, row].sort(byPath), eventSeq: action.event.seq };
    }
    case 'event/app.unpublished': {
      const { path } = action.event.payload;
      const known = state.items.find(item => item.path === path);

      return known && known.slug !== null ? { ...state, items: state.items.map(item => (item === known ? { ...item, slug: null } : item)), eventSeq: action.event.seq } : state;
    }
    default:
      return state;
  }
}
