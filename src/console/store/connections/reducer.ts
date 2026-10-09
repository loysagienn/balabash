import type { ConnectionView, ServiceView } from '../../../api/contract.ts';
import type { Action } from '../types.ts';

export type ConnectionsState = { byId: Record<string, ConnectionView>; ids: string[]; catalog: ServiceView[] };

export function connectionsReducer(state: ConnectionsState = { byId: {}, ids: [], catalog: [] }, action: Action): ConnectionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId: Record<string, ConnectionView> = {};

      for (const connection of action.snapshot.connections) {
        byId[connection.id] = connection;
      }

      return { byId, ids: action.snapshot.connections.map(connection => connection.id), catalog: action.snapshot.services };
    }
    default:
      return state;
  }
}
