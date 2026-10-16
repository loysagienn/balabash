import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppRoute } from '../../lib/router/routes.ts';
import { createRouterReducer } from '../../store/router/reducer.ts';
import type { RouterState } from '../../store/router/reducer.ts';
import { routeTo } from '../../store/router/actions.ts';
import {
  SLIDE_MS,
  canSwipe,
  dimAt,
  initialStage,
  onAnimDone,
  onGestureCancel,
  onGestureEnd,
  onGestureMove,
  onGestureStart,
  onNav,
  parallaxAt,
  scrollIntent,
} from './stage.logic.ts';
import type { StageEnv, StageState } from './stage.logic.ts';

const PHONE: StageEnv = { phone: true, reduced: false };
const WIDE: StageEnv = { phone: false, reduced: false };
const STILL: StageEnv = { phone: true, reduced: true };

const THREADS: AppRoute = { key: 'threads' };
const THREAD: AppRoute = { key: 'thread', id: 't1' };
const OTHER: AppRoute = { key: 'thread', id: 't2' };
const PROJECTS: AppRoute = { key: 'projects' };

// A router driven like the store's: app navigations and popstates.
function router(initial: AppRoute) {
  const reduce = createRouterReducer(initial);
  let state = reduce(undefined, { type: 'TAB_VISIBLE' });

  return {
    get state(): RouterState {
      return state;
    },
    go(route: AppRoute, options: Parameters<typeof routeTo>[1] = {}) {
      state = reduce(state, routeTo(route, options));

      return state;
    },
    pop(entry: number | null) {
      const known = state.pages.find(page => page.entry === entry);

      state = reduce(state, routeTo(known?.route ?? { key: 'home' }, { source: 'history', entry }));

      return state;
    },
  };
}

const noPlace = () => null;
const pages = (state: StageState) => state.layers.map(layer => layer.page);

describe('stage — navigations', () => {
  it('slides a nested page in over the page it opens from, and lets the old page go when the slide ends', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    assert.deepEqual(pages(stage), [1]);
    stage = onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [1, 2]);
    assert.equal(stage.current, 2);
    assert.deepEqual(stage.motion, {
      top: 2,
      under: 1,
      offset: 1,
      target: 0,
      driver: 'anim',
      duration: SLIDE_MS,
      ease: 'slide',
    });
    assert.deepEqual(stage.layers[1]!.scroll, { kind: 'top' });

    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [2]);
    assert.equal(stage.motion, null);
  });

  it('slides the nested page out on a step back, with the parent beneath at its place', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    stage = onNav(stage, { router: nav.pop(1), env: PHONE, place: entry => (entry === 1 ? 480 : null) });
    assert.deepEqual(pages(stage), [1, 2]);
    assert.equal(stage.current, 1);
    assert.deepEqual(stage.motion, {
      top: 2,
      under: 1,
      offset: 0,
      target: 1,
      driver: 'anim',
      duration: SLIDE_MS,
      ease: 'slide',
    });
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'restore', place: 480 });
    assert.equal(stage.layers[0]!.move, 'back');

    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [1]);
    assert.equal(stage.motion, null);
  });

  it('cuts without a motion on a wide screen, between sections, inside one page, on a replace and on an unknown entry', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onNav(stage, { router: nav.go(THREAD), env: WIDE, place: noPlace });
    assert.deepEqual(pages(stage), [2]);
    assert.equal(stage.motion, null);

    // A section's tab: a push to a top-level page.
    stage = onNav(stage, { router: nav.go(PROJECTS), env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [3]);
    assert.equal(stage.motion, null);

    // The project page slides in; inside it the page stays, told to keep its place.
    stage = onAnimDone(onNav(stage, { router: nav.go({ key: 'project', slug: 'p' }), env: PHONE, place: noPlace }));
    assert.deepEqual(pages(stage), [4]);
    stage = onNav(stage, { router: nav.go({ key: 'project', slug: 'p', path: 'docs' }), env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [4]);
    assert.equal(stage.motion, null);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'keep' });
    assert.deepEqual(stage.layers[0]!.route, { key: 'project', slug: 'p', path: 'docs' });

    // A replace: the same page, the route changed, the scroll at the top (another page's words).
    stage = onNav(stage, {
      router: nav.go({ key: 'project', slug: 'p', path: 'docs/a.md' }, { replace: true }),
      env: PHONE,
      place: noPlace,
    });
    assert.deepEqual(pages(stage), [4]);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'keep' });

    // An unknown entry: a cut.
    stage = onNav(stage, { router: nav.pop(null), env: PHONE, place: noPlace });
    assert.equal(stage.motion, null);
    assert.equal(stage.layers.length, 1);
  });

  it('turns the slide around when the user goes back while the page is still sliding in', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace });
    stage = { ...stage, motion: { ...stage.motion!, offset: 0.4 } };
    stage = onNav(stage, { router: nav.pop(1), env: PHONE, place: noPlace });
    assert.equal(stage.current, 1);
    assert.deepEqual(stage.motion, {
      top: 2,
      under: 1,
      offset: 0.4,
      target: 1,
      driver: 'anim',
      duration: SLIDE_MS,
      ease: 'slide',
    });
    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [1]);
  });

  it('snaps a slide to its end when a third page comes', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace });
    stage = onNav(stage, { router: nav.go(OTHER), env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [2, 3]);
    assert.equal(stage.current, 3);
    assert.deepEqual(stage.motion, {
      top: 3,
      under: 2,
      offset: 1,
      target: 0,
      driver: 'anim',
      duration: SLIDE_MS,
      ease: 'slide',
    });
  });

  it('takes no time with reduced motion', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onNav(stage, { router: nav.go(THREAD), env: STILL, place: noPlace });
    assert.equal(stage.motion!.duration, 0);
  });

  it('says what a navigation does to the scroll', () => {
    assert.deepEqual(scrollIntent('push', THREADS, THREAD, null), { kind: 'top' });
    assert.deepEqual(scrollIntent('back', THREAD, THREADS, 300), { kind: 'restore', place: 300 });
    assert.deepEqual(scrollIntent('forward', THREADS, THREAD, 0), { kind: 'restore', place: 0 });
    assert.deepEqual(scrollIntent('back', THREAD, THREADS, null), { kind: 'top' });
    assert.deepEqual(
      scrollIntent('back', { key: 'project', slug: 'p', path: 'a' }, { key: 'project', slug: 'p' }, null),
      { kind: 'keep' },
    );
    assert.deepEqual(
      scrollIntent('within', { key: 'project', slug: 'p' }, { key: 'project', slug: 'p', path: 'a' }, null),
      { kind: 'keep' },
    );
    assert.deepEqual(scrollIntent('replace', THREADS, { key: 'threads', q: 'x' }, null), { kind: 'top' });
    assert.deepEqual(scrollIntent('unknown', null, THREADS, 10), { kind: 'top' });
  });
});

describe('stage — the swipe back', () => {
  it('opens the entry behind beneath the page when it is the parent, follows the finger, and asks for the step back on a commit', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    assert.equal(canSwipe(stage, PHONE), true);
    assert.equal(canSwipe(stage, WIDE), false);

    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: entry => (entry === 1 ? 480 : null) });
    assert.deepEqual(pages(stage), [1, 2]);
    assert.equal(stage.current, 2);
    assert.deepEqual(stage.motion, {
      top: 2,
      under: 1,
      offset: 0,
      target: 0,
      driver: 'gesture',
      duration: 0,
      ease: 'settle',
    });
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'restore', place: 480 });
    assert.equal(stage.layers[0]!.move, 'back');
    assert.equal(canSwipe(stage, PHONE), false);

    stage = onGestureMove(stage, 0.6);
    assert.equal(stage.motion!.offset, 0.6);
    stage = onGestureMove(stage, -0.2);
    assert.equal(stage.motion!.offset, 0);
    stage = onGestureMove(stage, 0.6);

    const step = onGestureEnd(stage, 0, 390, PHONE);

    assert.deepEqual(step.effects, [{ kind: 'back', fallback: THREADS }]);
    assert.equal(step.state.motion!.target, 1);
    assert.equal(step.state.motion!.driver, 'anim');
    assert.equal(step.state.motion!.ease, 'settle');
    assert.ok(step.state.motion!.duration > 0);

    // The animation ends before the browser answers: the page waits off the screen.
    stage = onAnimDone(step.state);
    assert.deepEqual(pages(stage), [1, 2]);
    assert.equal(stage.motion!.driver, 'done');

    // The popstate lands on the page beneath: the motion is over; the page,
    // already at its place, keeps it.
    stage = onNav(stage, { router: nav.pop(1), env: PHONE, place: entry => (entry === 1 ? 480 : null) });
    assert.deepEqual(pages(stage), [1]);
    assert.equal(stage.current, 1);
    assert.equal(stage.motion, null);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'keep' });
  });

  it('takes the popstate before the animation ends too', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: noPlace });
    stage = onGestureEnd(onGestureMove(stage, 0.7), 1, 390, PHONE).state;
    stage = onNav(stage, { router: nav.pop(1), env: PHONE, place: noPlace });
    assert.equal(stage.current, 1);
    assert.deepEqual(
      stage.motion && {
        top: stage.motion.top,
        under: stage.motion.under,
        target: stage.motion.target,
        driver: stage.motion.driver,
      },
      { top: 2, under: 1, target: 1, driver: 'anim' },
    );
    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [1]);
    assert.equal(stage.motion, null);
  });

  it('brings the page back on a short drag, a fling back or a cancel, and drops the preview', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: noPlace });

    const short = onGestureEnd(onGestureMove(stage, 0.3), 0, 390, PHONE);

    assert.deepEqual(short.effects, []);
    assert.equal(short.state.motion!.target, 0);
    assert.deepEqual(pages(onAnimDone(short.state)), [2]);
    assert.equal(onAnimDone(short.state).motion, null);

    const fling = onGestureEnd(onGestureMove(stage, 0.8), -1, 390, PHONE);

    assert.deepEqual(fling.effects, []);
    assert.equal(fling.state.motion!.target, 0);

    const cancelled = onGestureCancel(onGestureMove(stage, 0.5), PHONE);

    assert.equal(cancelled.motion!.target, 0);
    assert.equal(cancelled.motion!.driver, 'anim');
    assert.deepEqual(pages(onAnimDone(cancelled)), [2]);
  });

  it('previews the page behind whatever it is — a thread opened from a thread goes back to that thread', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    stage = onAnimDone(onNav(stage, { router: nav.go(OTHER), env: PHONE, place: noPlace }));
    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: entry => (entry === 2 ? 4551 : null) });
    assert.deepEqual(pages(stage), [2, 3]);
    assert.deepEqual(stage.layers[0]!.route, THREAD);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'restore', place: 4551 });

    const step = onGestureEnd(onGestureMove(stage, 0.9), 0, 390, PHONE);

    assert.deepEqual(step.effects, [{ kind: 'back', fallback: THREAD }]);
    stage = onNav(step.state, { router: nav.pop(2), env: PHONE, place: noPlace });
    assert.equal(stage.current, 2);
    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [2]);
  });

  it('previews the parent itself when the tab knows nothing behind, and adopts the page the step back opens', () => {
    // A deep link to a thread: the first page of the tab.
    const nav = router(THREAD);
    let stage = initialStage(nav.state);

    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: noPlace });
    assert.equal(stage.layers[0]!.page < 0, true);
    assert.deepEqual(stage.layers[0]!.route, THREADS);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'top' });

    const step = onGestureEnd(onGestureMove(stage, 0.9), 0, 390, PHONE);

    assert.deepEqual(step.effects, [{ kind: 'back', fallback: THREADS }]);
    // The handler pushes the parent, marked as a step back: the preview becomes that page.
    stage = onNav(step.state, { router: nav.go(THREADS, { back: true }), env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [2, 1]);
    assert.deepEqual(stage.layers[0]!.scroll, { kind: 'keep' });
    assert.equal(stage.current, 2);
    assert.equal(stage.motion!.under, 2);
    assert.equal(stage.motion!.target, 1);
    stage = onAnimDone(stage);
    assert.deepEqual(pages(stage), [2]);
  });

  it('takes over a page sliding in, from where it is', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    stage = onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace });
    stage = { ...stage, motion: { ...stage.motion!, offset: 0.5 } };
    assert.equal(canSwipe(stage, PHONE), true);
    stage = onGestureStart(stage, { router: nav.state, env: PHONE, place: noPlace });
    assert.deepEqual(pages(stage), [1, 2]);
    assert.equal(stage.motion!.driver, 'gesture');
    assert.equal(stage.motion!.offset, 0.5);

    // Flung off: the page beneath is the entry behind — the step back goes through history.
    const step = onGestureEnd(onGestureMove(stage, 0.6), 2, 390, PHONE);

    assert.deepEqual(step.effects, [{ kind: 'back', fallback: THREADS }]);
  });

  it('refuses a swipe on a top-level page, and on a page sliding out', () => {
    const nav = router(THREADS);
    let stage = initialStage(nav.state);

    assert.equal(canSwipe(stage, PHONE), false);
    assert.equal(onGestureStart(stage, { router: nav.state, env: PHONE, place: noPlace }), stage);

    stage = onAnimDone(onNav(stage, { router: nav.go(THREAD), env: PHONE, place: noPlace }));
    stage = onNav(stage, { router: nav.pop(1), env: PHONE, place: noPlace });
    assert.equal(canSwipe(stage, PHONE), false);
  });

  it('draws the page beneath a little behind, under a dim that lifts', () => {
    assert.equal(parallaxAt(1), 0);
    assert.ok(parallaxAt(0) < 0);
    assert.equal(dimAt(1), 0);
    assert.ok(dimAt(0) > 0);
  });
});
