// The run journal's queries follow the store's stamp of the journal: over
// a fake store and a counting client, a moved stamp invalidates the
// journal's queries (all of them, by the prefix) once; another domain
// changing, or the stamp standing, invalidates nothing; a disconnected
// process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { JOB_RUNS_KEY, connectQueryClientToSchedule } from './schedule.ts';

function fakeStore(runsChanged = 0) {
  const listeners = new Set<() => void>();
  let stamp = runsChanged;
  const store = {
    getState: () => ({ schedule: { tasks: {}, ids: [], calls: {}, runsChanged: stamp } }) as unknown as State,
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

describe('the run journal against the store', () => {
  it('invalidates the journal once per moved stamp, not on other changes', () => {
    const { store, bump, touch } = fakeStore(3);
    const { client, invalidated } = countingClient();
    const disconnect = connectQueryClientToSchedule(store, client);

    touch();
    assert.deepEqual(invalidated, []);

    bump();
    assert.deepEqual(invalidated, [JOB_RUNS_KEY]);

    touch();
    assert.equal(invalidated.length, 1);

    bump();
    bump();
    assert.equal(invalidated.length, 3);

    disconnect();
    bump();
    assert.equal(invalidated.length, 3);
  });
});
