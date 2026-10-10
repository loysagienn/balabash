import { createSelector } from 'reselect';
import type { ConnectionView, ServiceView } from '../../../api/contract.ts';
import { idleForm } from '../../lib/forms/attempt.ts';
import type { FormCallState } from '../../lib/forms/attempt.ts';
import type { State } from '../types.ts';
import { ownCall } from './reducer.ts';
import type { ConnectionCall, ConnectionFailure, ConnectionLink } from './reducer.ts';

export const selectConnectionsState = (state: State) => state.connections;
export const selectConnections = createSelector([selectConnectionsState], connections =>
  connections.ids.map(id => connections.byId[id]).filter((connection): connection is ConnectionView => connection !== undefined),
);
// Connections that await the user (sign-in required again).
export const selectConnectionsNeedingAction = createSelector([selectConnections], connections =>
  connections.filter(connection => connection.status === 'reauthorization_required'),
);
export const selectServices = (state: State): ServiceView[] => state.connections.catalog;
export const selectConnectionCall = (state: State, id: string): ConnectionCall | null => ownCall(state.connections.calls, id) ?? null;
export const selectConnectionRename = (state: State, id: string): FormCallState => state.connections.renames[id] ?? idleForm;
export const selectServiceConnect = (state: State, server: string): FormCallState => state.connections.connects[server] ?? idleForm;
export const selectConnectionLink = (state: State, id: string): ConnectionLink | null => (Object.hasOwn(state.connections.links, id) ? state.connections.links[id]! : null);
export const selectConnectionFailure = (state: State, id: string): ConnectionFailure | null => (Object.hasOwn(state.connections.failures, id) ? state.connections.failures[id]! : null);
