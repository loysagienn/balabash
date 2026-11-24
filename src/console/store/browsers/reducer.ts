// The linked browsers are data of the second layer (GET /api/browsers, read
// by the Connections screen through TanStack Query); the store only knows
// that they changed. `changed` is a stamp moved by every `browsers` frame of
// the stream and by every command of this tab that changed the list —
// lib/query/browsers.ts reads the list again on it.
//
// `switching` — the browsers whose switch "in this workspace" the user has
// just flipped: the value the switch shows meanwhile. A switch in flight
// (settled: false) takes no second flip; an accepted one (settled: true)
// keeps showing its value until the list is read again (BROWSERS_READ), so
// the switch does not jump back for the moment the old list is still on
// screen; a refused one is forgotten at once — the switch goes back.

import type { Action } from '../types.ts';
import type { BrowserSwitch } from './actions.ts';

export type BrowsersState = { changed: number; switching: Record<string, BrowserSwitch> };

export const initialBrowsers: BrowsersState = { changed: 0, switching: {} };

function without(switching: Record<string, BrowserSwitch>, id: string): Record<string, BrowserSwitch> {
  const { [id]: _gone, ...rest } = switching;

  return rest;
}

export function browsersReducer(state: BrowsersState = initialBrowsers, action: Action): BrowsersState {
  switch (action.type) {
    case 'BROWSERS_CHANGED_REMOTELY':
      return { ...state, changed: state.changed + 1 };
    case 'SET_BROWSER_HERE':
      return { ...state, switching: { ...state.switching, [action.id]: { on: action.on, settled: false } } };
    case 'SET_BROWSER_HERE_DONE':
      return state.switching[action.id] === action.call
        ? { changed: state.changed + 1, switching: { ...state.switching, [action.id]: { on: action.call.on, settled: true } } }
        : state;
    case 'SET_BROWSER_HERE_FAIL':
      return state.switching[action.id] === action.call ? { changed: state.changed + 1, switching: without(state.switching, action.id) } : state;
    case 'BROWSERS_READ': {
      const settled = Object.keys(state.switching).filter(id => state.switching[id]?.settled);

      return settled.length === 0 ? state : { ...state, switching: settled.reduce(without, state.switching) };
    }
    default:
      return state;
  }
}
