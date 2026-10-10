// The connections: the snapshot's rows and the catalog of connectable
// services, then the connection.* family of the tail keeps the rows: pending
// (a link was issued — the row exists, whole in the payload), completed
// (the row as it is after the flow — status, identity, scope, dates — whole
// in the payload; the row it names may be another than the pending one when
// the consent landed on an already connected account), failed (the flow's
// error, kept beside the row until the next link or a completion),
// reauthorization_required (the status), renamed (the name), disconnected
// (the row is gone). The events carry the row's id (connectionId); an event
// recorded before the id was added names the account only and is not
// folded; a completed recorded before it carried the row patches the status
// and the identity. Beside the rows — the operator's own commands
// (actions.ts): the answer of a rename and of a link folds the row at once
// (the tail's event then finds the same row), a disconnect drops it; the
// call in flight per row (a disconnect or a reconnect, applied by
// identity), the form of a rename per row and of a connect per service
// (lib/forms/attempt.ts); the sign-in links answered to this tab, by row —
// a link is never in the log, so only the tab that asked holds it, until
// the flow ends (completed, or the row is gone) or a newer link replaces it
// (connection.pending with a later updatedAt than the one the link came
// with — another tab or an agent re-issued it, which killed this one).

import type { ConnectionView, ServiceView } from '../../../api/contract.ts';
import type { FormCallState } from '../../lib/forms/attempt.ts';
import { idleForm } from '../../lib/forms/attempt.ts';
import { connectionFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type ConnectionCall = { kind: 'disconnect' } | { kind: 'reconnect' };

// A sign-in link answered to this tab: the address, when it stops working,
// the row's updatedAt it was issued with.
export type ConnectionLink = { url: string; expiresAt: Date; issuedAt: Date };

// The flow's last failure (connection.failed of the tail): the error and
// its moment, until the next link or a completion.
export type ConnectionFailure = { error: string; at: Date };

export type ConnectionsState = {
  byId: Record<string, ConnectionView>;
  ids: string[];
  catalog: ServiceView[];
  calls: Record<string, ConnectionCall>;
  renames: Record<string, FormCallState>;
  connects: Record<string, FormCallState>;
  links: Record<string, ConnectionLink>;
  failures: Record<string, ConnectionFailure>;
};

export const initialConnections: ConnectionsState = { byId: {}, ids: [], catalog: [], calls: {}, renames: {}, connects: {}, links: {}, failures: {} };

// The call in flight for a row — read by own key: an id could be named like
// a key of Object.prototype.
export function ownCall(calls: Record<string, ConnectionCall>, id: string): ConnectionCall | undefined {
  return Object.hasOwn(calls, id) ? calls[id] : undefined;
}

function patch(state: ConnectionsState, id: string | undefined, change: (connection: ConnectionView) => ConnectionView): ConnectionsState {
  const known = id ? state.byId[id] : undefined;

  if (!known) {
    return state;
  }

  const next = change(known);

  return next === known ? state : { ...state, byId: { ...state.byId, [id as string]: next } };
}

function upsert(state: ConnectionsState, connection: ConnectionView): ConnectionsState {
  return { ...state, byId: { ...state.byId, [connection.id]: connection }, ids: state.ids.includes(connection.id) ? state.ids : [...state.ids, connection.id] };
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!Object.hasOwn(record, id)) {
    return record;
  }

  const { [id]: dropped, ...rest } = record;

  return rest;
}

function withoutCall(state: ConnectionsState, id: string, request: ConnectionCall): ConnectionsState {
  return ownCall(state.calls, id) === request ? { ...state, calls: without(state.calls, id) } : state;
}

// The row is gone: nothing of it stays — not the link, not the failure.
function withoutRow(state: ConnectionsState, id: string | undefined): ConnectionsState {
  if (!id || !state.byId[id]) {
    return state;
  }

  return { ...state, byId: without(state.byId, id), ids: state.ids.filter(known => known !== id), links: without(state.links, id), failures: without(state.failures, id) };
}

function withLink(state: ConnectionsState, connection: ConnectionView, url: string, expiresAt: Date): ConnectionsState {
  return { ...upsert(state, connection), links: { ...state.links, [connection.id]: { url, expiresAt, issuedAt: connection.updatedAt } }, failures: without(state.failures, connection.id) };
}

function withRename(state: ConnectionsState, id: string, form: (current: FormCallState) => FormCallState): ConnectionsState {
  return { ...state, renames: { ...state.renames, [id]: form(state.renames[id] ?? idleForm) } };
}

function withConnect(state: ConnectionsState, server: string, form: (current: FormCallState) => FormCallState): ConnectionsState {
  return { ...state, connects: { ...state.connects, [server]: form(state.connects[server] ?? idleForm) } };
}

export function connectionsReducer(state: ConnectionsState = initialConnections, action: Action): ConnectionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ConnectionView> = {};

      for (const connection of action.snapshot.connections) {
        byId[connection.id] = connection;
      }

      return { ...state, byId, ids: action.snapshot.connections.map(connection => connection.id), catalog: action.snapshot.services };
    }
    case 'event/connection.pending': {
      const connection = connectionFromRecord(action.event.payload);

      if (!connection) {
        return state;
      }

      const held = state.links[connection.id];
      const next = upsert(state, connection);

      // A link issued after the one held killed it (a new nonce per issue).
      return held && connection.updatedAt.getTime() > held.issuedAt.getTime() ? { ...next, links: without(next.links, connection.id) } : next;
    }
    case 'event/connection.completed': {
      const record = connectionFromRecord(action.event.payload);

      if (record) {
        const next = upsert(state, record);

        return { ...next, links: without(next.links, record.id), failures: without(next.failures, record.id) };
      }

      const { connectionId, identity } = action.event.payload;
      const updatedAt = action.event.createdAt;
      const next = patch(state, connectionId, connection => ({ ...connection, status: 'connected', identity: identity ?? connection.identity, updatedAt }));

      return connectionId ? { ...next, links: without(next.links, connectionId), failures: without(next.failures, connectionId) } : next;
    }
    case 'event/connection.failed': {
      const { connectionId, error } = action.event.payload;
      const updatedAt = action.event.createdAt;

      if (!connectionId || !state.byId[connectionId]) {
        return state;
      }

      return { ...patch(state, connectionId, connection => ({ ...connection, updatedAt })), failures: { ...state.failures, [connectionId]: { error, at: updatedAt } } };
    }
    case 'event/connection.reauthorization_required': {
      const updatedAt = action.event.createdAt;

      return patch(state, action.event.payload.connectionId, connection => ({ ...connection, status: 'reauthorization_required', updatedAt }));
    }
    case 'event/connection.renamed': {
      const { connectionId, name } = action.event.payload;
      const updatedAt = action.event.createdAt;

      return patch(state, connectionId, connection => ({ ...connection, displayName: name, updatedAt }));
    }
    case 'event/connection.disconnected':
      return withoutRow(state, action.event.payload.connectionId);
    case 'RENAME_CONNECTION':
      return withRename(state, action.id, form => ({ ...form, pending: true, error: null }));
    case 'RENAME_CONNECTION_DONE':
      return upsert(
        withRename(state, action.id, form => ({ pending: false, error: null, done: form.done + 1 })),
        action.connection,
      );
    case 'RENAME_CONNECTION_FAIL':
      return withRename(state, action.id, form => ({ ...form, pending: false, error: action.error }));
    case 'DISCONNECT_CONNECTION':
      return ownCall(state.calls, action.id) ? state : { ...state, calls: { ...state.calls, [action.id]: { kind: 'disconnect' } } };
    case 'RECONNECT_CONNECTION':
      return ownCall(state.calls, action.id) ? state : { ...state, calls: { ...state.calls, [action.id]: { kind: 'reconnect' } } };
    case 'DISCONNECT_CONNECTION_DONE': {
      if (ownCall(state.calls, action.id) !== action.request) {
        return state;
      }

      return withoutRow(withoutCall(state, action.id, action.request), action.connection.id);
    }
    case 'RECONNECT_CONNECTION_DONE': {
      if (ownCall(state.calls, action.id) !== action.request) {
        return state;
      }

      return withLink(withoutCall(state, action.id, action.request), action.link.connection, action.link.url, action.link.expiresAt);
    }
    case 'DISCONNECT_CONNECTION_FAIL':
    case 'RECONNECT_CONNECTION_FAIL':
      return withoutCall(state, action.id, action.request);
    case 'CONNECT_SERVICE':
      return withConnect(state, action.server, form => ({ ...form, pending: true, error: null }));
    case 'CONNECT_SERVICE_DONE':
      return withLink(
        withConnect(state, action.server, form => ({ pending: false, error: null, done: form.done + 1 })),
        action.link.connection,
        action.link.url,
        action.link.expiresAt,
      );
    case 'CONNECT_SERVICE_FAIL':
      return withConnect(state, action.server, form => ({ ...form, pending: false, error: action.error }));
    default:
      return state;
  }
}
