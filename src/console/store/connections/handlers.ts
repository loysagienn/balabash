// The effects of the connections domain: the operator's rename, disconnect,
// reconnect and connect. A rename and a connect are forms — one call per
// form at a time, the refusal stays in the store for the dialog to show,
// the acceptance closes it (lib/forms/attempt.ts); a disconnect and a
// reconnect are one call per row at a time (connections.calls[id]), their
// outcome applied by the identity of that call — an answer that outlived
// its session (a sign-out, the next sign-in) touches nothing — and told by
// a toast, a refusal too. A link answered (reconnect, connect) is held
// beside its row; the toast says where to open it.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { pushToast } from '../ui/actions.ts';
import { connectServiceDone, connectServiceFail, disconnectConnectionDone, disconnectConnectionFail, reconnectConnectionDone, reconnectConnectionFail, renameConnectionDone, renameConnectionFail } from './actions.ts';
import { ownCall } from './reducer.ts';
import { disconnectedWords, linkReadyWords, renamedWords } from './words.ts';

export const renameConnectionHandler: ActionHandler<'RENAME_CONNECTION'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().connections.renames[action.id]?.pending) {
      return;
    }

    next(action);

    const previous = getState().connections.byId[action.id]?.displayName ?? action.name;

    try {
      const { connection } = await api.connections.rename(action.id, action.name);

      dispatch(renameConnectionDone(action.id, connection));

      if (connection.displayName !== previous) {
        dispatch(pushToast(renamedWords(previous, connection)));
      }
    } catch (error) {
      dispatch(renameConnectionFail(action.id, toApiFailure(error)));
    }
  };

export const disconnectConnectionHandler: ActionHandler<'DISCONNECT_CONNECTION'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (ownCall(getState().connections.calls, action.id)) {
      return;
    }

    next(action);

    const request = ownCall(getState().connections.calls, action.id);

    if (!request) {
      return;
    }

    const name = getState().connections.byId[action.id]?.displayName ?? action.id;

    try {
      const { connection } = await api.connections.disconnect(action.id);

      if (ownCall(getState().connections.calls, action.id) !== request) {
        return;
      }

      dispatch(disconnectConnectionDone(action.id, request, connection));
      dispatch(pushToast(disconnectedWords(connection)));
    } catch (error) {
      if (ownCall(getState().connections.calls, action.id) !== request) {
        return;
      }

      const failure = toApiFailure(error);

      dispatch(disconnectConnectionFail(action.id, request, failure));
      dispatch(pushToast({ title: `Couldn’t disconnect “${name}”`, desc: failure.message, state: 'err' }));
    }
  };

export const reconnectConnectionHandler: ActionHandler<'RECONNECT_CONNECTION'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (ownCall(getState().connections.calls, action.id)) {
      return;
    }

    next(action);

    const request = ownCall(getState().connections.calls, action.id);

    if (!request) {
      return;
    }

    const name = getState().connections.byId[action.id]?.displayName ?? action.id;

    try {
      const link = await api.connections.reconnect(action.id);

      if (ownCall(getState().connections.calls, action.id) !== request) {
        return;
      }

      dispatch(reconnectConnectionDone(action.id, request, link));
      dispatch(pushToast(linkReadyWords(link.connection, link.expiresAt)));
    } catch (error) {
      if (ownCall(getState().connections.calls, action.id) !== request) {
        return;
      }

      const failure = toApiFailure(error);

      dispatch(reconnectConnectionFail(action.id, request, failure));
      dispatch(pushToast({ title: `Couldn’t get a sign-in link for “${name}”`, desc: failure.message, state: 'err' }));
    }
  };

export const connectServiceHandler: ActionHandler<'CONNECT_SERVICE'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().connections.connects[action.server]?.pending) {
      return;
    }

    next(action);

    try {
      const link = await api.connections.connect(action.name === null ? { server: action.server } : { server: action.server, name: action.name });

      dispatch(connectServiceDone(action.server, link));
      dispatch(pushToast(linkReadyWords(link.connection, link.expiresAt)));
    } catch (error) {
      dispatch(connectServiceFail(action.server, toApiFailure(error)));
    }
  };
