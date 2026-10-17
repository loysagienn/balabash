// What a screen knows of its own place in the navigation: the page it
// shows and the route of that page, fixed by the stage (app/stage) when
// the page is mounted and updated by the navigations that touch it — not
// read from the store, because the stage keeps a leaving page on the
// screen while the next one slides in, and the leaving page must not
// learn of the route it is leaving for. `nav` is the identity of the last
// navigation that touched the page (the shell's scroll effect runs on it);
// `scroll` says what that navigation does to the body's place. The value
// changes only with a navigation that touches the page: a page leaving
// the screen, or waiting beneath a swipe, is not rendered again for the
// moves of the others. The shell gives the stage its
// scroller (frame) and tells it whether the screen is a detail (no tabs
// on the phone: the toasts sit lower).

import { createContext, useContext } from 'react';
import type { NavMove } from '../../store/router/reducer.ts';
import type { AppRoute } from './routes.ts';

export type ScrollIntent = { kind: 'keep' } | { kind: 'top' } | { kind: 'restore'; place: number };

export type ScreenNav = {
  page: number;
  route: AppRoute;
  hash: string;
  move: NavMove;
  nav: number;
  scroll: ScrollIntent;
  frame: (element: HTMLElement | null) => void;
  setDetail: (detail: boolean) => void;
};

// A screen outside the stage (the showcase, a test) has a navigation of
// its own: the home route, at the top.
export const DETACHED_NAV: ScreenNav = {
  page: 0,
  route: { key: 'home' },
  hash: '',
  move: 'unknown',
  nav: 0,
  scroll: { kind: 'top' },
  frame: () => {},
  setDetail: () => {},
};

const ScreenNavContext = createContext<ScreenNav>(DETACHED_NAV);

export const ScreenNavProvider = ScreenNavContext.Provider;

export function useScreenNav(): ScreenNav {
  return useContext(ScreenNavContext);
}
