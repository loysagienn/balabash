import { createSelector } from 'reselect';
import type { ConnectionView } from '../../../api/contract.ts';
import type { State } from '../types.ts';

export const selectConnectionsState = (state: State) => state.connections;
export const selectConnections = createSelector([selectConnectionsState], connections =>
  connections.ids.map(id => connections.byId[id]).filter((connection): connection is ConnectionView => connection !== undefined),
);
// Connections that await the user (sign-in required again).
export const selectConnectionsNeedingAction = createSelector([selectConnections], connections =>
  connections.filter(connection => connection.status === 'reauthorization_required'),
);
