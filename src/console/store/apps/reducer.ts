// The apps: the snapshot's listing (every app folder of the file area with
// its publication), then app.published / app.unpublished of the tail keep
// the folder's row, and the listing read again (LOAD_APPS — the Apps screen
// entered, the tab back in view, a Retry) replaces the rows: a folder written
// after the snapshot or a manifest edited since has no event, only the
// listing knows it. A publication carries the manifest as validated at
// publish time — name and description — so the row takes them and drops
// any manifest error the snapshot knew (the manifest was fixed before the
// publish could succeed); a folder the listing does not know yet joins with
// that identity. eventSeq — the seq of the last app.* event the tail
// brought, whether or not it changed a row (an unpublish of a folder the
// rows do not know is still newer than a listing that was read before it):
// a listing requested before it may predate it and is not applied
// (store/apps/handlers.ts asks again). refresh.request — the one read in
// flight, by identity: an answer is applied only while the store waits for
// exactly that request, so an answer of a read that outlived its session
// (sign-out, a lost session, the next sign-in) neither touches the rows nor
// frees the request of the new session.

import type { AppListingView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';

// A read of the listing in flight: `since` — apps.eventSeq when it left.
export type AppsRequest = { since: bigint | null };

export type AppsState = {
  items: AppListingView[];
  publicAppsBase: string;
  eventSeq: bigint | null;
  refresh: { request: AppsRequest | null; error: ApiFailure | null };
};

export const initialApps: AppsState = { items: [], publicAppsBase: '', eventSeq: null, refresh: { request: null, error: null } };

const byPath = (a: AppListingView, b: AppListingView) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function sameRow(a: AppListingView, b: AppListingView): boolean {
  return a.path === b.path && a.slug === b.slug && a.name === b.name && a.description === b.description && a.manifestError === b.manifestError;
}

// The same rows in the same order: a listing that changed nothing is no
// change of state (the screen keeps its elements).
export function sameListing(a: AppListingView[], b: AppListingView[]): boolean {
  return a.length === b.length && a.every((row, i) => sameRow(row, b[i]));
}

// The tail's app.* event dates the rows; a replayed seq (the overlap of a
// reconnection) does not move the stamp back.
function stamped(state: AppsState, items: AppListingView[], seq: bigint): AppsState {
  const eventSeq = state.eventSeq !== null && seq <= state.eventSeq ? state.eventSeq : seq;

  return items === state.items && eventSeq === state.eventSeq ? state : { ...state, items, eventSeq };
}

export function appsReducer(state: AppsState = initialApps, action: Action): AppsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, items: action.snapshot.apps.apps, publicAppsBase: action.snapshot.apps.publicAppsBase };
    case 'LOAD_APPS':
      return { ...state, refresh: { request: { since: state.eventSeq }, error: null } };
    case 'LOAD_APPS_DONE': {
      if (action.request !== state.refresh.request) {
        return state;
      }

      const refresh = { request: null, error: null };

      if (action.request.since !== state.eventSeq) {
        return { ...state, refresh };
      }

      const items = sameListing(state.items, action.apps.apps) ? state.items : action.apps.apps;

      return { ...state, items, publicAppsBase: action.apps.publicAppsBase, refresh };
    }
    case 'LOAD_APPS_FAIL':
      return action.request === state.refresh.request ? { ...state, refresh: { request: null, error: action.error } } : state;
    case 'event/app.published': {
      const { path, slug, name, description } = action.event.payload;

      if (!path || !slug) {
        return stamped(state, state.items, action.event.seq);
      }

      const row: AppListingView = { path, slug, name: name ?? null, description: description ?? null, manifestError: null };
      const known = state.items.find(item => item.path === path);

      if (known) {
        return stamped(state, sameRow(known, row) ? state.items : state.items.map(item => (item === known ? row : item)), action.event.seq);
      }

      return stamped(state, [...state.items, row].sort(byPath), action.event.seq);
    }
    case 'event/app.unpublished': {
      const { path } = action.event.payload;
      const known = state.items.find(item => item.path === path);

      return stamped(state, known && known.slug !== null ? state.items.map(item => (item === known ? { ...item, slug: null } : item)) : state.items, action.event.seq);
    }
    default:
      return state;
  }
}
