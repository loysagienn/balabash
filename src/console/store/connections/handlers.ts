// The effects of the connections domain: the operator's rename, disconnect,
// reconnect and connect. A rename and a connect are forms — one call per
// form at a time, the refusal stays in the store for the dialog to show,
// the acceptance closes it (lib/forms/attempt.ts); a disconnect and a
// reconnect are one call per row at a time (connections.calls[id]) and
// told by a toast, a refusal too. Every outcome is applied by the identity
// of the call or form the store held when the command went out — an
// answer that outlived its session (a sign-out, the next sign-in), its
// row (disconnected meanwhile) or its form touches nothing. A link
// answered (reconnect, connect) is held beside its row; the toast says
// where to open it — only when the store took the link (an answer the
// tail moved past holds no link, and says nothing).

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { pushToast } from '../ui/actions.ts';
import { connectServiceDone, connectServiceFail, disconnectConnectionDone, disconnectConnectionFail, reconnectConnectionDone, reconnectConnectionFail, renameConnectionDone, renameConnectionFail } from './actions.ts';
import { ownCall } from './reducer.ts';
import { disconnectedWords, linkReadyWords, renamedWords } from './words.ts';
import { selectConnectionLink } from './selectors.ts';

export const renameConnectionHandler: ActionHandler<'RENAME_CONNECTION'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().connections.renames[action.id]?.pending) {
      return;
    }

    next(action);

    const request = getState().connections.renames[action.id];

    if (!request?.pending) {
      return;
    }

    const previous = getState().connections.byId[action.id]?.displayName ?? action.name;

    try {
      const { connection } = await api.connections.rename(action.id, action.name);

      if (getState().connections.renames[action.id] !== request) {
        return;
      }

      dispatch(renameConnectionDone(action.id, request, connection));

      // Told only when the row now carries the answered name (an unchanged
      // name is quiet; a row the tail moved past shows another name).
      if (connection.displayName !== previous && getState().connections.byId[action.id]?.displayName === connection.displayName) {
        dispatch(pushToast(renamedWords(previous, connection)));
      }
    } catch (error) {
      if (getState().connections.renames[action.id] !== request) {
        return;
      }

      dispatch(renameConnectionFail(action.id, request, toApiFailure(error)));
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

      if (selectConnectionLink(getState(), action.id)?.url === link.url) {
        dispatch(pushToast(linkReadyWords(link.connection, link.expiresAt)));
      }
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

    const request = getState().connections.connects[action.server];

    if (!request?.pending) {
      return;
    }

    try {
      const link = await api.connections.connect(action.name === null ? { server: action.server } : { server: action.server, name: action.name });

      if (getState().connections.connects[action.server] !== request) {
        return;
      }

      dispatch(connectServiceDone(action.server, request, link));

      if (selectConnectionLink(getState(), link.connection.id)?.url === link.url) {
        dispatch(pushToast(linkReadyWords(link.connection, link.expiresAt)));
      }
    } catch (error) {
      if (getState().connections.connects[action.server] !== request) {
        return;
      }

      dispatch(connectServiceFail(action.server, request, toApiFailure(error)));
    }
  };
