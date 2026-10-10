// The form of a one-time link follows the request of its id: over a fake
// store and a real QueryClient, a request issued again (the same id, a new
// moment) invalidates the cached form — a mounted one refetches, one left
// in the cache is stale for its next mount; an unchanged row, a row that
// merely closes, and an id the cache does not hold invalidate nothing; a
// disconnected process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { OpenSecretRequestView } from '../../../api/contract.ts';
import { secretRequestKey } from '../../screens/outside/Secrets.logic.ts';
import type { SecretRequestState } from '../../screens/outside/Secrets.logic.ts';
import type { Action, State } from '../../store/types.ts';
import { connectQueryClientToSecretRequests, reissuedRequests } from './secret-requests.ts';

const open = (partial: Partial<OpenSecretRequestView> = {}): OpenSecretRequestView => ({ id: 'r1', kind: 'external-secrets', server: 'yandex-direct', fields: ['API_KEY'], threadId: 'auth-1', agent: 'auth', requestedAt: new Date('2026-10-10T10:00:00.000Z'), ...partial });

const form = (fields: string[]): SecretRequestState => ({ kind: 'form', request: { id: 'r1', kind: 'external-secrets', server: 'yandex-direct', fields: fields.map(key => ({ key, label: key, description: '', required: true, secret: true })) } });

function fakeStore(...requests: OpenSecretRequestView[]) {
  const listeners = new Set<() => void>();
  let byId = Object.fromEntries(requests.map(request => [request.id, request]));
  const store = {
    getState: () => ({ secretRequests: { byId, ids: Object.keys(byId) } }) as State,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  } as unknown as Store<State, Action>;

  return {
    store,
    listeners,
    // A new state of the domain (the reducers never mutate theirs).
    become: (...next: OpenSecretRequestView[]) => {
      byId = Object.fromEntries(next.map(request => [request.id, request]));
      listeners.forEach(listener => listener());
    },
    // Another domain changed: the same object of this one.
    touch: () => listeners.forEach(listener => listener()),
  };
}

function countingClient() {
  const invalidated: unknown[] = [];

  return { client: { invalidateQueries: async (filters?: { queryKey?: unknown }) => void invalidated.push(filters?.queryKey) }, invalidated };
}

describe('the form of a one-time link against the store', () => {
  it('names the requests new to the store or issued again, not the unchanged or the closed', () => {
    const r1 = open();
    const r2 = open({ id: 'r2', kind: 'oauth-client', server: 'google', requestedAt: new Date('2026-10-10T11:00:00.000Z') });

    assert.deepEqual(reissuedRequests({}, { r1 }), ['r1']);
    assert.deepEqual(reissuedRequests({ r1 }, { r1 }), []);
    assert.deepEqual(reissuedRequests({ r1 }, { r1: open({ fields: ['API_KEY', 'TOKEN'], threadId: 'auth-2', requestedAt: new Date('2026-10-10T12:00:00.000Z') }) }), ['r1']);
    assert.deepEqual(reissuedRequests({ r1 }, { r1: open({ requestedAt: new Date('2026-10-10T10:00:00.000Z') }), r2 }), ['r2']);
    assert.deepEqual(reissuedRequests({ r1, r2 }, { r2 }), []);
  });

  it('invalidates the query of a request issued again, and nothing for an unchanged domain or a closing row', () => {
    const { store, become, touch } = fakeStore(open());
    const { client, invalidated } = countingClient();

    connectQueryClientToSecretRequests(store, client);

    touch();
    become(open());
    assert.deepEqual(invalidated, []);

    become(open({ fields: ['API_KEY', 'TOKEN'], requestedAt: new Date('2026-10-10T12:00:00.000Z') }));
    assert.deepEqual(invalidated, [secretRequestKey('r1')]);

    become();
    assert.deepEqual(invalidated, [secretRequestKey('r1')]);

    // The next request of the server is a new row: its own id.
    become(open({ id: 'r7', requestedAt: new Date('2026-10-10T13:00:00.000Z') }));
    assert.deepEqual(invalidated, [secretRequestKey('r1'), secretRequestKey('r7')]);
  });

  it('is silent once disconnected', () => {
    const { store, listeners, become } = fakeStore(open());
    const { client, invalidated } = countingClient();
    const disconnect = connectQueryClientToSecretRequests(store, client);

    assert.equal(listeners.size, 1);
    disconnect();
    assert.equal(listeners.size, 0);

    become(open({ requestedAt: new Date('2026-10-10T12:00:00.000Z') }));
    assert.deepEqual(invalidated, []);
  });

  it('makes the cached form stale for its next mount and refetches a mounted one, leaving the other ids alone', async () => {
    const { store, become } = fakeStore(open());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const fetchForm = async () => {
      reads += 1;

      return form(['API_KEY', 'TOKEN']);
    };

    connectQueryClientToSecretRequests(store, client);

    // The form read before the second request, as the screen keeps it, and
    // an outcome of another id — a card the invalidation must not touch.
    client.setQueryData(secretRequestKey('r1'), form(['API_KEY']));
    client.setQueryData(secretRequestKey('r0'), { kind: 'saved', server: 'notion' } satisfies SecretRequestState);

    const query = client.getQueryCache().find({ queryKey: secretRequestKey('r1') });

    assert.ok(query);
    assert.equal(query.isStaleByTime(Infinity), false);

    become(open({ fields: ['API_KEY', 'TOKEN'], requestedAt: new Date('2026-10-10T12:00:00.000Z') }));

    // Left in the cache: stale despite staleTime Infinity — the next mount reads again.
    assert.equal(query.isStaleByTime(Infinity), true);
    assert.equal(client.getQueryCache().find({ queryKey: secretRequestKey('r0') })?.isStaleByTime(Infinity), false);
    assert.deepEqual(client.getQueryData(secretRequestKey('r1')), form(['API_KEY']), 'the old form stays until the read answers');

    assert.deepEqual(await client.fetchQuery({ queryKey: secretRequestKey('r1'), queryFn: fetchForm, staleTime: Infinity }), form(['API_KEY', 'TOKEN']));
    assert.equal(reads, 1);
    // Fresh again: the same mount reads no more.
    assert.deepEqual(await client.fetchQuery({ queryKey: secretRequestKey('r1'), queryFn: fetchForm, staleTime: Infinity }), form(['API_KEY', 'TOKEN']));
    assert.equal(reads, 1);

    client.clear();
  });
});
