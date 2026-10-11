// The system facts follow the store's restarts stamp: over a fake store
// and a counting client, a moved stamp invalidates the system query once;
// the stamp standing invalidates nothing; a disconnected process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { SYSTEM_KEY, connectQueryClientToSystem } from './system.ts';

function fakeStore(restartsChanged = 0) {
  const listeners = new Set<() => void>();
  let stamp = restartsChanged;
  const store = {
    getState: () => ({ system: { log: [], restartsChanged: stamp } }) as unknown as State,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  } as unknown as Store<State, Action>;

  return {
    store,
    bump: () => {
      stamp += 1;
      listeners.forEach(listener => listener());
    },
    touch: () => listeners.forEach(listener => listener()),
  };
}

function countingClient() {
  const invalidated: unknown[] = [];

  return { client: { invalidateQueries: async (filters?: { queryKey?: unknown }) => void invalidated.push(filters?.queryKey) }, invalidated };
}

describe('the system facts over the restarts stamp', () => {
  it('invalidates the system query once per moved stamp, nothing while it stands', () => {
    const { store, bump, touch } = fakeStore(2);
    const { client, invalidated } = countingClient();

    connectQueryClientToSystem(store, client);
    touch();
    assert.deepEqual(invalidated, []);
    bump();
    assert.deepEqual(invalidated, [SYSTEM_KEY]);
    touch();
    bump();
    assert.deepEqual(invalidated, [SYSTEM_KEY, SYSTEM_KEY]);
  });

  it('is silent once disconnected', () => {
    const { store, bump } = fakeStore();
    const { client, invalidated } = countingClient();
    const disconnect = connectQueryClientToSystem(store, client);

    disconnect();
    bump();
    assert.deepEqual(invalidated, []);
  });
});
