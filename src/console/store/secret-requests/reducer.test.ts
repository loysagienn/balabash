import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenSecretRequestView } from '../../../api/contract.ts';
import { eventAction } from '../events.ts';
import { event, resetSeq, snapshot } from '../fixtures.ts';
import { snapshotLoadDone } from '../stream/actions.ts';
import { initialSecretRequests, secretRequestsReducer } from './reducer.ts';
import type { SecretRequestsState } from './reducer.ts';

const reduce = (state: SecretRequestsState, ...events: Parameters<typeof event>[0][]) => events.reduce((acc, item) => secretRequestsReducer(acc, eventAction(event(item))), state);

const open = (partial: Partial<OpenSecretRequestView> = {}): OpenSecretRequestView => ({ id: 'r1', kind: 'external-secrets', server: 'yandex-direct', fields: ['API_KEY'], threadId: 'auth-1', agent: 'auth', requestedAt: new Date('2026-10-10T10:00:00.000Z'), ...partial });

describe('secret requests reducer', () => {
  it('starts from the snapshot, in its order', () => {
    const state = secretRequestsReducer(initialSecretRequests, snapshotLoadDone(snapshot({ secretRequests: [open(), open({ id: 'r2', kind: 'oauth-client', server: 'google', fields: ['client_id', 'client_secret'] })] })));

    assert.deepEqual(state.ids, ['r1', 'r2']);
    assert.equal(state.byId.r2.kind, 'oauth-client');
  });

  it('opens a request from the tail with the event as its author and replaces it when issued again', () => {
    resetSeq(10n);

    const asked = { requestId: 'r1', server: 'yandex-direct', fields: ['API_KEY'], requestedAt: '2026-10-10T10:00:00.000Z' };
    const state = reduce(initialSecretRequests, { type: 'secrets.requested', agentName: 'auth', threadId: 'auth-1', payload: asked });

    assert.deepEqual(state.byId.r1, open());

    const again = reduce(state, { type: 'secrets.requested', agentName: 'auth', threadId: 'auth-2', payload: { ...asked, fields: ['API_KEY', 'TOKEN'], requestedAt: '2026-10-10T11:00:00.000Z' } });

    assert.deepEqual(again.ids, ['r1']);
    assert.deepEqual(again.byId.r1, open({ threadId: 'auth-2', fields: ['API_KEY', 'TOKEN'], requestedAt: new Date('2026-10-10T11:00:00.000Z') }));

    const client = reduce(again, { type: 'oauth_client.requested', agentName: 'auth', threadId: 'auth-2', payload: { requestId: 'r2', server: 'google', fields: ['client_id', 'client_secret'], requestedAt: '2026-10-10T12:00:00.000Z' } });

    assert.deepEqual(client.ids, ['r1', 'r2']);
    assert.equal(client.byId.r2.kind, 'oauth-client');
    // A record without its id is not folded.
    assert.equal(reduce(client, { type: 'secrets.requested', payload: { server: 'x', fields: [] } }), client);
  });

  it('closes a request when the values land: by the id the event names, by the server and kind when it names none', () => {
    const both = secretRequestsReducer(initialSecretRequests, snapshotLoadDone(snapshot({ secretRequests: [open(), open({ id: 'r2', kind: 'oauth-client', server: 'yandex-direct', fields: ['client_id', 'client_secret'] })] })));

    const byId = reduce(both, { type: 'secrets.provisioned', actor: 'system', payload: { requestId: 'r1', server: 'yandex-direct', fields: ['API_KEY'] } });

    assert.deepEqual(byId.ids, ['r2']);

    // The same server, the other kind: only the OAuth client's row goes.
    const byServer = reduce(both, { type: 'oauth_client.provisioned', actor: 'system', payload: { server: 'yandex-direct', fields: ['client_id'] } });

    assert.deepEqual(byServer.ids, ['r1']);
    // Nothing to close: the same state.
    assert.equal(reduce(byServer, { type: 'oauth_client.provisioned', actor: 'system', payload: { server: 'yandex-direct', fields: ['client_id'] } }), byServer);
    assert.equal(reduce(byServer, { type: 'secrets.provisioned', actor: 'system', payload: { requestId: 'r9', server: 'yandex-direct', fields: [] } }), byServer);
  });

  it('leaves other events alone', () => {
    assert.equal(reduce(initialSecretRequests, { type: 'connection.pending', payload: {} }, { type: 'user.message', actor: 'user', payload: { text: 'hi' } }), initialSecretRequests);
  });
});
