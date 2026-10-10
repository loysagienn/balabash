import type { ConnectLinkResponse, ConnectionView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { FormCallState } from '../../lib/forms/attempt.ts';
import type { ConnectionCall } from './reducer.ts';

// The operator's commands over the accounts of external services from the
// Connections screen (PATCH / DELETE /api/connections/:id, POST
// /api/connections/:id/reconnect, POST /api/connections). A rename is a
// form per row (its refusal shows in the dialog), a connect a form per
// service; a disconnect and a reconnect are one call per row at a time
// (connections.calls[id]). Every outcome names the call it answers
// (`request`: the form state or the call the store held when the command
// went out) and is applied only while the store still waits for exactly
// that one — an answer that outlived its session, its row or its form
// touches nothing. A link answered (reconnect, connect) is held beside
// its row until the flow ends or a newer link replaces it; the row itself
// comes back as connection.pending of the tail, idempotently.
export const renameConnection = (id: string, name: string) => ({ type: 'RENAME_CONNECTION', id, name }) as const;
export const renameConnectionDone = (id: string, request: FormCallState, connection: ConnectionView) => ({ type: 'RENAME_CONNECTION_DONE', id, request, connection }) as const;
export const renameConnectionFail = (id: string, request: FormCallState, error: ApiFailure) => ({ type: 'RENAME_CONNECTION_FAIL', id, request, error }) as const;
export const disconnectConnection = (id: string) => ({ type: 'DISCONNECT_CONNECTION', id }) as const;
export const disconnectConnectionDone = (id: string, request: ConnectionCall, connection: ConnectionView) => ({ type: 'DISCONNECT_CONNECTION_DONE', id, request, connection }) as const;
export const disconnectConnectionFail = (id: string, request: ConnectionCall, error: ApiFailure) => ({ type: 'DISCONNECT_CONNECTION_FAIL', id, request, error }) as const;
export const reconnectConnection = (id: string) => ({ type: 'RECONNECT_CONNECTION', id }) as const;
export const reconnectConnectionDone = (id: string, request: ConnectionCall, link: ConnectLinkResponse) => ({ type: 'RECONNECT_CONNECTION_DONE', id, request, link }) as const;
export const reconnectConnectionFail = (id: string, request: ConnectionCall, error: ApiFailure) => ({ type: 'RECONNECT_CONNECTION_FAIL', id, request, error }) as const;
export const connectService = (server: string, name: string | null) => ({ type: 'CONNECT_SERVICE', server, name }) as const;
export const connectServiceDone = (server: string, request: FormCallState, link: ConnectLinkResponse) => ({ type: 'CONNECT_SERVICE_DONE', server, request, link }) as const;
export const connectServiceFail = (server: string, request: FormCallState, error: ApiFailure) => ({ type: 'CONNECT_SERVICE_FAIL', server, request, error }) as const;
