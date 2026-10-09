// The connections: the snapshot's rows and the catalog of connectable
// services, then the connection.* family of the tail keeps the rows: pending
// (a link was issued — the row exists, whole in the payload), completed
// (connected, with the identity), failed (touched), reauthorization_required
// (the status), renamed (the name), disconnected (the row is gone). The
// events carry the row's id (connectionId); an event recorded before the id
// was added names the account only and is not folded.

import type { ConnectionView, ServiceView } from '../../../api/contract.ts';
import { connectionFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type ConnectionsState = { byId: Record<string, ConnectionView>; ids: string[]; catalog: ServiceView[] };

function patch(state: ConnectionsState, id: string | undefined, change: (connection: ConnectionView) => ConnectionView): ConnectionsState {
  const known = id ? state.byId[id] : undefined;

  if (!known) {
    return state;
  }

  const next = change(known);

  return next === known ? state : { ...state, byId: { ...state.byId, [id as string]: next } };
}

export function connectionsReducer(state: ConnectionsState = { byId: {}, ids: [], catalog: [] }, action: Action): ConnectionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ConnectionView> = {};

      for (const connection of action.snapshot.connections) {
        byId[connection.id] = connection;
      }

      return { byId, ids: action.snapshot.connections.map(connection => connection.id), catalog: action.snapshot.services };
    }
    case 'event/connection.pending': {
      const connection = connectionFromRecord(action.event.payload);

      if (!connection) {
        return state;
      }

      return { ...state, byId: { ...state.byId, [connection.id]: connection }, ids: state.ids.includes(connection.id) ? state.ids : [...state.ids, connection.id] };
    }
    case 'event/connection.completed': {
      const { connectionId, identity } = action.event.payload;
      const updatedAt = action.event.createdAt;

      return patch(state, connectionId, connection => ({ ...connection, status: 'connected', identity: identity ?? connection.identity, updatedAt }));
    }
    case 'event/connection.failed': {
      const updatedAt = action.event.createdAt;

      return patch(state, action.event.payload.connectionId, connection => ({ ...connection, updatedAt }));
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
    case 'event/connection.disconnected': {
      const { connectionId } = action.event.payload;

      if (!connectionId || !state.byId[connectionId]) {
        return state;
      }

      const { [connectionId]: dropped, ...byId } = state.byId;

      return { ...state, byId, ids: state.ids.filter(id => id !== connectionId) };
    }
    default:
      return state;
  }
}
