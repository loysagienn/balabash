// The stage: which pages are on the screen and how they move. The rules,
// pure — the DOM wiring is Stage.tsx, stageMotion.ts and useSwipeBack.ts.
//
// Layers are the mounted pages, in stacking order (the last is on top).
// There are one or two: the current page alone, or two during a motion —
// the one that moves (`top`) and the one beneath it (`under`). `offset` is
// where the top layer is, 0 — in place, 1 — off the right edge of the
// screen; `target` — where it is going; the driver — what moves it: the
// animation, the finger, or nothing (`done` — it is at the target and the
// stage waits for the navigation the gesture asked for). On the phone a
// push to a nested page slides it in from the right over the page it was
// opened from (that page stays beneath, dimmed, for the time of the
// slide); a step back slides the nested page out to the right and shows
// the parent beneath — already the current page of the store: the URL has
// changed, the leaving page is a guest. A swipe back opens the parent
// beneath the page before the store knows (a preview — the entry behind,
// the page this one was opened from, when the tab knows it; else the
// parent itself, provisional, to be adopted when the navigation lands —
// the same rule as GO_BACK) and moves the page with the
// finger; the lift settles it, and a commit asks for the navigation.
// Every other navigation (a section's tab, a replace, a move inside one
// page, an unknown entry, a wide screen) is a cut: the new page alone.
//
// Interruptions: a navigation to the layer beneath while the top moves
// (the back arrow pressed as the page slides in) turns the motion around
// from where it is; a navigation to a third page snaps the motion to its
// end and cuts; a finger on a page that is sliding in takes it over from
// where it is. A navigation to the page already on the screen (a filter
// replaced, a move inside a project, a popstate between two entries of
// the same page) only tells the page what to do with its scroll.

import { settle } from '../../lib/gesture/settle.ts';
import { nested, parentRoute, samePage } from '../../lib/router/nesting.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { ScrollIntent } from '../../lib/router/screen.tsx';
import { pageBehind, sameRoute } from '../../store/router/reducer.ts';
import type { NavMove, RouterState } from '../../store/router/reducer.ts';

// The time of a push or a step back that no finger drives.
export const SLIDE_MS = 320;
// How far the page beneath moves along with the top one (a share of the width).
export const PARALLAX = 0.3;
// How dark the page beneath gets under the top one at rest (the dim's opacity).
export const DIM = 0.3;

export type StageLayer = {
  // A page of the store, or a provisional preview (negative) of the parent
  // the tab does not have behind this page.
  page: number;
  entry: number | null;
  route: AppRoute;
  hash: string;
  move: NavMove;
  nav: number;
  scroll: ScrollIntent;
};

export type MotionDriver = 'anim' | 'gesture' | 'done';

export type Motion = {
  top: number;
  under: number;
  offset: number;
  target: 0 | 1;
  driver: MotionDriver;
  // The time of the animation's way to the target, ms (the anim driver),
  // and its curve: a slide the navigation made, or the settle of a finger.
  duration: number;
  ease: 'slide' | 'settle';
};

export type StageState = {
  layers: StageLayer[];
  // The page the store shows.
  current: number;
  motion: Motion | null;
  // The identity of the last navigation.
  nav: number;
};

export type StageEnv = { phone: boolean; reduced: boolean };

// What the stage asks of the store: the step back a committed swipe is.
export type StageEffect = { kind: 'back'; fallback: AppRoute };

export type StageStep = { state: StageState; effects: StageEffect[] };

const PREVIEW_PAGE = -1;

function layerOf(router: RouterState, scroll: ScrollIntent, nav: number): StageLayer {
  const page = router.pages[router.index]!;

  return { page: page.page, entry: page.entry, route: page.route, hash: page.hash, move: router.move, nav, scroll };
}

export function initialStage(router: RouterState): StageState {
  const layer = layerOf(router, { kind: 'top' }, 1);

  return { layers: [layer], current: layer.page, motion: null, nav: 1 };
}

// What a navigation does to the body's place of the page it lands on: a
// history move brings back the place the entry was left at, when the
// stage kept one; a move inside the same page keeps the place; anything
// else starts at the top. (The place a history move has none for: the
// same page — kept; another page — the top.)
export function scrollIntent(move: NavMove, from: AppRoute | null, to: AppRoute, place: number | null): ScrollIntent {
  if ((move === 'back' || move === 'forward') && place !== null) {
    return { kind: 'restore', place };
  }

  if (
    move === 'within' ||
    ((move === 'replace' || move === 'back' || move === 'forward') && from !== null && samePage(from, to))
  ) {
    return { kind: 'keep' };
  }

  return { kind: 'top' };
}

function current(state: StageState): StageLayer {
  return state.layers.find(layer => layer.page === state.current)!;
}

// The motion settled at its target: the layer that lost stays off.
function snapped(state: StageState): StageState {
  const motion = state.motion;

  if (!motion) {
    return state;
  }

  const gone = motion.target === 0 ? motion.under : motion.top;

  return { ...state, layers: state.layers.filter(layer => layer.page !== gone), motion: null };
}

export type NavInput = { router: RouterState; env: StageEnv; place: (entry: number) => number | null };

export function onNav(state: StageState, { router, env, place }: NavInput): StageState {
  const page = router.pages[router.index]!;
  const nav = state.nav + 1;
  const from = current(state);
  const known =
    state.layers.find(layer => layer.page === page.page) ??
    state.layers.find(layer => layer.page < 0 && sameRoute(layer.route, page.route));

  if (known) {
    // A page already on the screen: told its route and scroll; a preview
    // adopted. A layer other than the current one (the page beneath a
    // swipe, the page a turned-around slide heads back to) is already at
    // its place: it keeps it. The motion, if any, now heads for the layer
    // that became current, from where it is.
    const scroll: ScrollIntent =
      known.page !== from.page
        ? { kind: 'keep' }
        : scrollIntent(router.move, from.route, page.route, known.entry === page.entry ? null : place(page.entry));
    const adopted: StageLayer = {
      ...known,
      page: page.page,
      entry: page.entry,
      route: page.route,
      hash: page.hash,
      move: router.move,
      nav,
      scroll,
    };
    const layers = state.layers.map(layer => (layer === known ? adopted : layer));
    let motion = state.motion;

    if (motion) {
      const top = motion.top === known.page ? page.page : motion.top;
      const under = motion.under === known.page ? page.page : motion.under;
      const target: 0 | 1 = top === page.page ? 0 : 1;

      motion = {
        ...motion,
        top,
        under,
        target,
        driver:
          motion.driver === 'gesture'
            ? 'gesture'
            : motion.target === target && motion.driver === 'done'
              ? 'done'
              : 'anim',
        duration: motion.driver === 'gesture' ? motion.duration : env.reduced ? 0 : SLIDE_MS,
        ease: 'slide',
      };

      if (motion.driver === 'done' && motion.offset === target) {
        return snapped({ ...state, layers, current: page.page, motion, nav });
      }
    }

    return { ...state, layers, current: page.page, motion, nav };
  }

  // A page new to the screen: a motion in flight snaps to its end first.
  const idle = snapped(state);
  const was = current(idle);
  const scroll = scrollIntent(router.move, was.route, page.route, place(page.entry));
  const layer: StageLayer = {
    page: page.page,
    entry: page.entry,
    route: page.route,
    hash: page.hash,
    move: router.move,
    nav,
    scroll,
  };
  const duration = env.reduced ? 0 : SLIDE_MS;

  if (env.phone && (router.move === 'push' || router.move === 'forward') && nested(page.route)) {
    return {
      layers: [was, layer],
      current: layer.page,
      motion: { top: layer.page, under: was.page, offset: 1, target: 0, driver: 'anim', duration, ease: 'slide' },
      nav,
    };
  }

  if (env.phone && router.move === 'back' && nested(was.route)) {
    return {
      layers: [layer, was],
      current: layer.page,
      motion: { top: was.page, under: layer.page, offset: 0, target: 1, driver: 'anim', duration, ease: 'slide' },
      nav,
    };
  }

  return { layers: [layer], current: layer.page, motion: null, nav };
}

// Whether a finger on the current page may start a swipe back: the phone,
// a nested page, and no motion the finger cannot take over (a page
// sliding in is taken over; a page sliding out is a guest — inert).
export function canSwipe(state: StageState, env: StageEnv): boolean {
  if (!env.phone || !nested(current(state).route)) {
    return false;
  }

  return state.motion === null || (state.motion.top === state.current && state.motion.driver !== 'gesture');
}

export type GestureInput = { router: RouterState; env: StageEnv; place: (entry: number) => number | null };

// The finger claims the page: the page behind opens beneath it (a
// preview), or the motion in flight becomes the finger's.
export function onGestureStart(state: StageState, { router, env, place }: GestureInput): StageState {
  if (!canSwipe(state, env)) {
    return state;
  }

  if (state.motion) {
    return { ...state, motion: { ...state.motion, driver: 'gesture' } };
  }

  const top = current(state);
  const parent = parentRoute(top.route)!;
  const behind = pageBehind(router);
  const nav = state.nav + 1;
  const under: StageLayer =
    behind
      ? {
          page: behind.page,
          entry: behind.entry,
          route: behind.route,
          hash: behind.hash,
          move: 'back',
          nav,
          scroll: scrollIntent('back', top.route, behind.route, place(behind.entry)),
        }
      : { page: PREVIEW_PAGE, entry: null, route: parent, hash: '', move: 'back', nav, scroll: { kind: 'top' } };

  return {
    ...state,
    layers: [under, top],
    motion: { top: top.page, under: under.page, offset: 0, target: 0, driver: 'gesture', duration: 0, ease: 'settle' },
    nav,
  };
}

export function onGestureMove(state: StageState, offset: number): StageState {
  const motion = state.motion;

  if (!motion || motion.driver !== 'gesture') {
    return state;
  }

  return { ...state, motion: { ...motion, offset: Math.max(0, Math.min(1, offset)) } };
}

// The lift: the page settles — on, or off — at the finger's pace; off,
// it asks for the step back (unless the page beneath is already current:
// the motion was a turn-around the store knows).
export function onGestureEnd(state: StageState, velocity: number, extent: number, env: StageEnv): StageStep {
  const motion = state.motion;

  if (!motion || motion.driver !== 'gesture') {
    return { state, effects: [] };
  }

  const { target, duration } = settle({ progress: motion.offset, velocity, extent, reduced: env.reduced });
  const next: StageState = { ...state, motion: { ...motion, target, driver: 'anim', duration, ease: 'settle' } };
  const under = state.layers.find(layer => layer.page === motion.under)!;
  const effects: StageEffect[] =
    target === 1 && motion.top === state.current ? [{ kind: 'back', fallback: under.route }] : [];

  return { state: next, effects };
}

// The finger taken away (the browser took the touch, a second finger): the
// page comes back to its place.
export function onGestureCancel(state: StageState, env: StageEnv): StageState {
  const motion = state.motion;

  if (!motion || motion.driver !== 'gesture') {
    return state;
  }

  const { duration } = settle({ progress: motion.offset, velocity: 0, extent: 1, reduced: env.reduced });

  return {
    ...state,
    motion: {
      ...motion,
      target: motion.top === state.current ? 0 : 1,
      driver: 'anim',
      duration: motion.offset === 0 ? 0 : duration,
      ease: 'settle',
    },
  };
}

// The animation reached the target: the motion is over — unless the page
// that left is still the store's current one (the step back asked for is
// on its way), then the stage waits for it with the page off the screen.
export function onAnimDone(state: StageState): StageState {
  const motion = state.motion;

  if (!motion || motion.driver !== 'anim') {
    return state;
  }

  const settled: Motion = { ...motion, offset: motion.target, driver: 'done' };

  if (motion.target === 1 && motion.top === state.current) {
    return { ...state, motion: settled };
  }

  return snapped({ ...state, motion: settled });
}

// The share of the dim and the parallax at an offset (stageMotion.ts draws them).
export function dimAt(offset: number): number {
  return (1 - offset) * DIM;
}

export function parallaxAt(offset: number): number {
  return (offset - 1) * PARALLAX;
}
