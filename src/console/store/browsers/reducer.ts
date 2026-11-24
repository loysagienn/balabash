// The linked browsers are data of the second layer (GET /api/browsers, read
// by the Connections screen through TanStack Query); the store only knows
// that they changed. `changed` is a stamp moved by every `browsers` frame of
// the stream — lib/query/browsers.ts reads the list again on it.

import type { Action } from '../types.ts';

export type BrowsersState = { changed: number };

export const initialBrowsers: BrowsersState = { changed: 0 };

export function browsersReducer(state: BrowsersState = initialBrowsers, action: Action): BrowsersState {
  return action.type === 'BROWSERS_CHANGED_REMOTELY' ? { changed: state.changed + 1 } : state;
}
