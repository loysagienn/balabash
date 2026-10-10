// The visibility process: the tab coming back into view (another tab or
// app was in front, the phone's screen was off) is a signal to the store —
// TAB_VISIBLE — and the route's handler decides what to read again
// (store/router/handlers.ts). Lives for the tab, only dispatches — a
// process, not a handler. visibilitychange alone, as TanStack Query's focus
// manager does: window focus fires on its own (an iframe, DevTools) and
// says nothing on a phone.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { tabVisible } from '../../store/router/actions.ts';

export type VisibilityDocument = Pick<Document, 'visibilityState'> & {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

export function connectStoreToVisibility(store: Store<State, Action>, doc: VisibilityDocument = document): () => void {
  const onChange = () => {
    if (doc.visibilityState === 'visible') {
      store.dispatch(tabVisible());
    }
  };

  doc.addEventListener('visibilitychange', onChange);

  return () => doc.removeEventListener('visibilitychange', onChange);
}
