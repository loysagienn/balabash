import { createSelector } from 'reselect';
import type { OpenSecretRequestView } from '../../../api/contract.ts';
import type { State } from '../types.ts';

export const selectSecretRequestsState = (state: State) => state.secretRequests;
// The open requests in the order they were issued (the snapshot's, then the tail's).
export const selectSecretRequests = createSelector([selectSecretRequestsState], requests =>
  requests.ids.map(id => requests.byId[id]).filter((request): request is OpenSecretRequestView => request !== undefined),
);
