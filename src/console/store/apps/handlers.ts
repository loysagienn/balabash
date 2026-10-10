// The effects of the apps domain. LOAD_APPS: one listing in flight at a
// time — the request the reducer put into apps.refresh.request — and an
// answer is dispatched only while the store still waits for exactly that
// request (the same rule as the threads handlers): after a sign-out, a lost
// session or the next sign-in the request is another one or none, and the
// old answer — a listing or a failure — is dropped without touching the
// rows or the new request. The server reads the listing at some moment of
// the request while the tail keeps flowing: an app.* event that arrived
// during the flight may be newer than the listing (a publish right after
// the scan), so the reducer leaves such an answer unapplied and the listing
// is asked for once more, from after the event. PUBLISH_APP / UNPUBLISH_APP:
// one call per app at a time (apps.calls[path]), the outcome applied by the
// identity of that call; a publication's answer folds the slug into the row
// and is told by a toast with the public address; a refusal of a publish
// stays in the dialog's form (the dialog shows it under the field or above
// the form), a refusal of an unpublish — a toast, there is no form.

import { toApiFailure } from '../../lib/api/index.ts';
import { appTitle, appUrlText, publicAppAddress } from '../../lib/apps/appLink.ts';
import type { ActionHandler } from '../types.ts';
import { pushToast } from '../ui/actions.ts';
import { loadApps, loadAppsDone, loadAppsFail, publishAppDone, publishAppFail, unpublishAppDone, unpublishAppFail } from './actions.ts';

export const loadAppsHandler: ActionHandler<'LOAD_APPS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().apps.refresh.request) {
      return;
    }

    next(action);

    const request = getState().apps.refresh.request;

    if (!request) {
      return;
    }

    try {
      const apps = await api.apps.list();

      if (getState().apps.refresh.request !== request) {
        return;
      }

      dispatch(loadAppsDone(request, apps));

      if (getState().apps.eventSeq !== request.since) {
        dispatch(loadApps());
      }
    } catch (error) {
      if (getState().apps.refresh.request !== request) {
        return;
      }

      dispatch(loadAppsFail(request, toApiFailure(error)));
    }
  };

// The name of an app for a toast: the row's, else the folder's.
const titleOf = (items: { path: string; name: string | null }[], path: string) => appTitle(items.find(item => item.path === path) ?? { name: null, path });

export const publishAppHandler: ActionHandler<'PUBLISH_APP'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().apps.calls[action.path]) {
      return;
    }

    next(action);

    const request = getState().apps.calls[action.path];

    if (!request) {
      return;
    }

    try {
      const publication = await api.apps.publish({ path: action.path, slug: action.slug });

      if (getState().apps.calls[action.path] !== request) {
        return;
      }

      const { items, publicAppsBase } = getState().apps;

      dispatch(publishAppDone(action.path, request, publication));
      dispatch(pushToast({ title: 'Published', desc: `“${titleOf(items, action.path)}” — ${appUrlText(publicAppAddress(publicAppsBase, publication.slug))}`, state: 'done' }));
    } catch (error) {
      if (getState().apps.calls[action.path] !== request) {
        return;
      }

      dispatch(publishAppFail(action.path, request, toApiFailure(error)));
    }
  };

export const unpublishAppHandler: ActionHandler<'UNPUBLISH_APP'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().apps.calls[action.path]) {
      return;
    }

    next(action);

    const request = getState().apps.calls[action.path];

    if (!request) {
      return;
    }

    try {
      const publication = await api.apps.unpublish({ path: action.path });

      if (getState().apps.calls[action.path] !== request) {
        return;
      }

      const { items, publicAppsBase } = getState().apps;

      dispatch(unpublishAppDone(action.path, request, publication));
      dispatch(pushToast({ title: 'Unpublished', desc: `“${titleOf(items, action.path)}” — the link ${appUrlText(publicAppAddress(publicAppsBase, publication.slug))} stopped working.`, state: 'off' }));
    } catch (error) {
      if (getState().apps.calls[action.path] !== request) {
        return;
      }

      const failure = toApiFailure(error);

      dispatch(unpublishAppFail(action.path, request, failure));
      dispatch(pushToast({ title: 'Couldn’t unpublish', desc: failure.message, state: 'err' }));
    }
  };
