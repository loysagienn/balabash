// The visibility process over a fake document: the tab's return is one
// TAB_VISIBLE, going hidden is nothing, a disconnected process is silent.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import type { VisibilityDocument } from './index.ts';
import { connectStoreToVisibility } from './index.ts';

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc: VisibilityDocument & { visibilityState: DocumentVisibilityState } = {
    visibilityState: 'visible',
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };

  return {
    doc,
    listeners,
    become: (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      listeners.forEach(listener => listener());
    },
  };
}

describe('the visibility process', () => {
  it('dispatches TAB_VISIBLE when the tab comes back into view, nothing when it goes away', () => {
    const actions: Action[] = [];
    const store = { dispatch: (action: Action) => actions.push(action) } as unknown as Store<State, Action>;
    const { doc, listeners, become } = fakeDocument();
    const disconnect = connectStoreToVisibility(store, doc);

    assert.equal(listeners.size, 1);
    assert.deepEqual(actions, []);

    become('hidden');
    assert.deepEqual(actions, []);

    become('visible');
    assert.deepEqual(actions, [{ type: 'TAB_VISIBLE' }]);

    disconnect();
    assert.equal(listeners.size, 0);
    become('hidden');
    become('visible');
    assert.equal(actions.length, 1);
  });
});
