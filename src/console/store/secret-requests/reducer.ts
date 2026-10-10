// The open requests for installation credentials — the one-time links the
// auth agent sent the operator (src/capabilities/secret-requests.ts): the
// snapshot's rows, then the tail keeps them — secrets.requested /
// oauth_client.requested upsert the row (a request issued again for the
// same server is the same row with the new moment), secrets.provisioned /
// oauth_client.provisioned close it. A provisioned event names the row by
// requestId; one recorded before the id was carried names the server —
// one open request per server and kind, so the server tells the row too.
// The bell reads them (features/notifications).

import type { OpenSecretRequestView } from '../../../api/contract.ts';
import { secretRequestFromRecord } from '../records.ts';
import type { Action } from '../types.ts';

export type SecretRequestsState = { byId: Record<string, OpenSecretRequestView>; ids: string[] };

export const initialSecretRequests: SecretRequestsState = { byId: {}, ids: [] };

function withRequest(state: SecretRequestsState, request: OpenSecretRequestView | null): SecretRequestsState {
  if (!request) {
    return state;
  }

  return { byId: { ...state.byId, [request.id]: request }, ids: state.ids.includes(request.id) ? state.ids : [...state.ids, request.id] };
}

function withoutRequest(state: SecretRequestsState, kind: OpenSecretRequestView['kind'], payload: { requestId?: string; server: string }): SecretRequestsState {
  const gone = state.ids.filter(id => {
    const request = state.byId[id];

    return request !== undefined && (payload.requestId ? request.id === payload.requestId : request.kind === kind && request.server === payload.server);
  });

  if (gone.length === 0) {
    return state;
  }

  const byId = { ...state.byId };

  for (const id of gone) {
    delete byId[id];
  }

  return { byId, ids: state.ids.filter(id => !gone.includes(id)) };
}

export function secretRequestsReducer(state: SecretRequestsState = initialSecretRequests, action: Action): SecretRequestsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      // A snapshot of a server older than this bundle (built, not yet
      // restarted) carries no requests: none open until the restart.
      const requests = action.snapshot.secretRequests ?? [];
      const byId: Record<string, OpenSecretRequestView> = {};

      for (const request of requests) {
        byId[request.id] = request;
      }

      return { byId, ids: requests.map(request => request.id) };
    }
    case 'event/secrets.requested':
    case 'event/oauth_client.requested': {
      const { event } = action;

      return withRequest(state, secretRequestFromRecord(action.type === 'event/secrets.requested' ? 'external-secrets' : 'oauth-client', event.payload, event));
    }
    case 'event/secrets.provisioned':
      return withoutRequest(state, 'external-secrets', action.event.payload);
    case 'event/oauth_client.provisioned':
      return withoutRequest(state, 'oauth-client', action.event.payload);
    default:
      return state;
  }
}
