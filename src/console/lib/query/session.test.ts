// The session boundary of the query client over a fake store and a real
// QueryClient: leaving the session clears queries and mutations — values a
// mutation carried included —, entering or staying in it clears nothing,
// a disconnected process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import type { SessionStatus } from '../../store/session/reducer.ts';
import { connectQueryClientToSession } from './session.ts';

function fakeStore(status: SessionStatus) {
  const listeners = new Set<() => void>();
  let current = status;
  const store = {
    getState: () => ({ session: { status: current } }) as State,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  } as unknown as Store<State, Action>;

  return {
    store,
    listeners,
    become: (status: SessionStatus) => {
      current = status;
      listeners.forEach(listener => listener());
    },
  };
}

function countingClient() {
  let clears = 0;

  return { client: { clear: () => void clears++ }, clears: () => clears };
}

describe('the session boundary of the query client', () => {
  it('clears the client when the session is lost or left, once per boundary', () => {
    const { store, become } = fakeStore('signed-in');
    const { client, clears } = countingClient();

    connectQueryClientToSession(store, client);

    become('signed-in');
    assert.equal(clears(), 0);

    become('anonymous');
    assert.equal(clears(), 1);

    // Still anonymous (another action, the sign-in form at work): nothing more.
    become('anonymous');
    assert.equal(clears(), 1);

    // Signing in again brings nothing to clear; leaving again does.
    become('signed-in');
    assert.equal(clears(), 1);
    become('anonymous');
    assert.equal(clears(), 2);
  });

  it('clears nothing on the way into a session', () => {
    const { store, become } = fakeStore('loading');
    const { client, clears } = countingClient();

    connectQueryClientToSession(store, client);

    become('anonymous');
    become('loading');
    become('error');
    become('loading');
    become('signed-in');
    assert.equal(clears(), 0);
  });

  it('is silent once disconnected', () => {
    const { store, listeners, become } = fakeStore('signed-in');
    const { client, clears } = countingClient();
    const disconnect = connectQueryClientToSession(store, client);

    assert.equal(listeners.size, 1);
    disconnect();
    assert.equal(listeners.size, 0);

    become('anonymous');
    assert.equal(clears(), 0);
  });

  it('leaves no query data and no mutation variables behind the boundary', async () => {
    const { store, become } = fakeStore('signed-in');
    const client = new QueryClient();
    const unsubscribe = client.getMutationCache().subscribe(() => {});

    connectQueryClientToSession(store, client);

    client.setQueryData(['secret-request', 'a'], { kind: 'saved', server: 'notion' });

    // A mutation that has settled keeps its variables in the cache (that is
    // TanStack's own contract); the boundary is what ends them.
    const mutation = client.getMutationCache().build(client, { mutationFn: async (values: Record<string, string>) => values });

    await mutation.execute({ token: 'plain-value' });
    assert.deepEqual(mutation.state.variables, { token: 'plain-value' });
    assert.equal(client.getQueryCache().getAll().length, 1);
    assert.equal(client.getMutationCache().getAll().length, 1);

    become('anonymous');

    assert.equal(client.getQueryData(['secret-request', 'a']), undefined);
    assert.equal(client.getQueryCache().getAll().length, 0);
    assert.equal(client.getMutationCache().getAll().length, 0);

    unsubscribe();
    client.clear();
  });
});
