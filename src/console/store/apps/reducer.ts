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
// frees the request of the new session. The operator's own changes — a
// publication under a slug, its end — are one call per app at a time
// (calls[path], by identity like the listing's request). Three sources
// write the rows — the listing, the tail, the answers of the operator's
// own calls — and each is applied only while nothing fresher has been seen
// since it left: an answer folds its slug into the row only while the tail
// brought no app.* event during the call (listingStale / callOutrun —
// otherwise the tail's events are the newer word on the row, and the
// call's own event is among them or on its way); `changes` counts the
// answers accepted so far, and a listing that left before one of them is
// stale as well (the listing may have been read before the call's commit,
// and the call's event has not stamped eventSeq yet). The maps keyed by an
// app path are read by own keys only (own): a folder may be named like a
// key of Object.prototype. The publish dialog's form keeps its refusal and
// accepted count per app (publish[path], lib/forms/attempt.ts); an
// unpublish has no form — its refusal is a toast (store/apps/handlers.ts).

import type { AppListingView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';

// A read of the listing in flight: `since` — apps.eventSeq when it left,
// `changes` — apps.changes then.
export type AppsRequest = { since: bigint | null; changes: number };

// The operator's call in flight for one app: a publication under `slug` or
// its end; `since` — apps.eventSeq when it left. One object per call — the
// outcome is applied by identity.
export type AppCall = ({ kind: 'publish'; slug: string } | { kind: 'unpublish' }) & { since: bigint | null };

// The publish dialog's form of one app: the refusal of the last call, how
// many calls the server accepted (the dialog closes when the count moves);
// whether a call is in flight — calls[path].
export type AppPublishForm = { error: ApiFailure | null; done: number };

export type AppsState = {
  items: AppListingView[];
  publicAppsBase: string;
  eventSeq: bigint | null;
  refresh: { request: AppsRequest | null; error: ApiFailure | null };
  // How many answers of the operator's own calls were accepted (a listing
  // that left before one of them is stale).
  changes: number;
  // By app path: the publish or unpublish call in flight.
  calls: Record<string, AppCall>;
  // By app path: the publish dialog's form.
  publish: Record<string, AppPublishForm>;
};

export const idlePublishForm: AppPublishForm = { error: null, done: 0 };

export const initialApps: AppsState = { items: [], publicAppsBase: '', eventSeq: null, refresh: { request: null, error: null }, changes: 0, calls: {}, publish: {} };

// The value a map keyed by an app path holds for the path itself — not
// what Object.prototype would lend a folder named constructor or toString.
export function own<T>(map: Record<string, T>, path: string): T | undefined {
  return Object.hasOwn(map, path) ? map[path] : undefined;
}

// Whether a listing that left with `request` is stale: an app.* event or an
// accepted answer of the operator's own call has been seen since.
export function listingStale(state: Pick<AppsState, 'eventSeq' | 'changes'>, request: AppsRequest): boolean {
  return request.since !== state.eventSeq || request.changes !== state.changes;
}

// Whether the tail brought an app.* event while the call was in flight:
// its answer is then not the freshest word on the row.
export function callOutrun(state: Pick<AppsState, 'eventSeq'>, call: AppCall): boolean {
  return call.since !== state.eventSeq;
}

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

function withCall(state: AppsState, path: string, call: AppCall | null): AppsState {
  if (call) {
    return { ...state, calls: { ...state.calls, [path]: call } };
  }

  if (!Object.hasOwn(state.calls, path)) {
    return state;
  }

  const { [path]: dropped, ...rest } = state.calls;

  return { ...state, calls: rest };
}

function withPublishForm(state: AppsState, path: string, form: (current: AppPublishForm) => AppPublishForm): AppsState {
  return { ...state, publish: { ...state.publish, [path]: form(own(state.publish, path) ?? idlePublishForm) } };
}

// The answer of the operator's own call accepted: the call is over, the
// answer counted; the row takes the answer's slug (null — unpublished) only
// while the tail brought nothing newer during the call.
function withAnswer(state: AppsState, path: string, call: AppCall, slug: string | null): AppsState {
  const ended = { ...withCall(state, path, null), changes: state.changes + 1 };

  return callOutrun(state, call) ? ended : withSlug(ended, path, slug);
}

// The row's publication as the answer of the operator's own call says it:
// the slug (null — unpublished). A row the listing does not know yet stays
// unknown — the tail's app.published brings the folder's identity.
function withSlug(state: AppsState, path: string, slug: string | null): AppsState {
  const known = state.items.find(item => item.path === path);

  return known && known.slug !== slug ? { ...state, items: state.items.map(item => (item === known ? { ...item, slug } : item)) } : state;
}

export function appsReducer(state: AppsState = initialApps, action: Action): AppsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, items: action.snapshot.apps.apps, publicAppsBase: action.snapshot.apps.publicAppsBase };
    case 'LOAD_APPS':
      return { ...state, refresh: { request: { since: state.eventSeq, changes: state.changes }, error: null } };
    case 'LOAD_APPS_DONE': {
      if (action.request !== state.refresh.request) {
        return state;
      }

      const refresh = { request: null, error: null };

      if (listingStale(state, action.request)) {
        return { ...state, refresh };
      }

      const items = sameListing(state.items, action.apps.apps) ? state.items : action.apps.apps;

      return { ...state, items, publicAppsBase: action.apps.publicAppsBase, refresh };
    }
    case 'LOAD_APPS_FAIL':
      return action.request === state.refresh.request ? { ...state, refresh: { request: null, error: action.error } } : state;
    case 'PUBLISH_APP':
      return withPublishForm(withCall(state, action.path, { kind: 'publish', slug: action.slug, since: state.eventSeq }), action.path, form => ({ ...form, error: null }));
    case 'PUBLISH_APP_DONE': {
      if (own(state.calls, action.path) !== action.request) {
        return state;
      }

      return withPublishForm(withAnswer(state, action.path, action.request, action.publication.slug), action.path, form => ({ error: null, done: form.done + 1 }));
    }
    case 'PUBLISH_APP_FAIL':
      return own(state.calls, action.path) === action.request ? withPublishForm(withCall(state, action.path, null), action.path, form => ({ ...form, error: action.error })) : state;
    case 'UNPUBLISH_APP':
      return withCall(state, action.path, { kind: 'unpublish', since: state.eventSeq });
    case 'UNPUBLISH_APP_DONE':
      return own(state.calls, action.path) === action.request ? withAnswer(state, action.path, action.request, null) : state;
    case 'UNPUBLISH_APP_FAIL':
      return own(state.calls, action.path) === action.request ? withCall(state, action.path, null) : state;
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
