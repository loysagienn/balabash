// The list of linked browsers follows the store's stamp: over a fake store
// and a counting client, a moved stamp invalidates the browsers query once;
// the stamp standing invalidates nothing; a disconnected process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { BROWSERS_KEY, connectQueryClientToBrowsers } from './browsers.ts';

function fakeStore() {
  const listeners = new Set<() => void>();
  let changed = 0;
  const store = {
    getState: () => ({ browsers: { changed } }) as unknown as State,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  } as unknown as Store<State, Action>;

  return {
    store,
    bump: () => {
      changed += 1;
      listeners.forEach(listener => listener());
    },
    touch: () => listeners.forEach(listener => listener()),
  };
}

describe('the linked browsers over the store’s stamp', () => {
  it('invalidates the browsers query once per moved stamp, nothing while it stands or after disconnecting', () => {
    const { store, bump, touch } = fakeStore();
    const invalidated: unknown[] = [];
    const disconnect = connectQueryClientToBrowsers(store, { invalidateQueries: async filters => void invalidated.push(filters?.queryKey) });

    touch();
    assert.deepEqual(invalidated, []);
    bump();
    touch();
    assert.deepEqual(invalidated, [BROWSERS_KEY]);
    bump();
    assert.deepEqual(invalidated, [BROWSERS_KEY, BROWSERS_KEY]);
    disconnect();
    bump();
    assert.equal(invalidated.length, 2);
  });
});
