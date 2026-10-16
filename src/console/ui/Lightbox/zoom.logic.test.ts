import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOUBLE_TAP_SCALE,
  FIT,
  ZoomGestures,
  clampView,
  doubleTapTarget,
  imageCenter,
  interpolateView,
  maxScale,
  panBy,
  pinchView,
  sameView,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
  zoomDragView,
} from './zoom.logic.ts';
import type { Geometry, Point, View } from './zoom.logic.ts';

// A 1000 × 800 stage with a 68 px bar: the 1200 × 800 picture fitted to
// 600 × 400, centered in the rectangle below the bar (its center 414 down).
const geometry: Geometry = { stage: { width: 1000, height: 800 }, image: { width: 600, height: 400 }, center: { x: 500, y: 414 }, natural: { width: 1200, height: 800 } };

function near(actual: View, expected: View, message?: string) {
  assert.ok(sameView(actual, expected), `${message ?? 'view'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
}

// Where the image point that was under `point` in `before` sits in `after`.
function follow(point: Point, before: View, after: View): Point {
  const c0 = imageCenter(before, geometry);
  const c1 = imageCenter(after, geometry);
  const k = after.scale / before.scale;

  return { x: c1.x + (point.x - c0.x) * k, y: c1.y + (point.y - c0.y) * k };
}

describe('the bounds', () => {
  it('the scale: half the fit at least, 2× the natural pixels (or 4× the fit) at most', () => {
    assert.equal(maxScale(geometry), 4);
    assert.equal(maxScale({ ...geometry, natural: { width: 6000, height: 4000 } }), 20);
    assert.equal(maxScale({ ...geometry, natural: null }), 4);
    assert.equal(clampView({ scale: 0.5, x: 0, y: 0 }, geometry).scale, 0.5);
    assert.equal(clampView({ scale: 0.2, x: 0, y: 0 }, geometry).scale, 0.5);
    assert.equal(clampView({ scale: 9, x: 0, y: 0 }, geometry).scale, 4);
  });

  it('the offset: the image may leave the stage by half of it, no further', () => {
    near(clampView(FIT, geometry), FIT, 'the fit is legal');
    // At the fit the center may travel to the stage's center ± the half-size: x 200…800, y 200…600.
    near(clampView({ scale: 1, x: 350, y: 0 }, geometry), { scale: 1, x: 300, y: 0 }, 'right');
    near(clampView({ scale: 1, x: -350, y: 0 }, geometry), { scale: 1, x: -300, y: 0 }, 'left');
    near(clampView({ scale: 1, x: 0, y: 300 }, geometry), { scale: 1, x: 0, y: 186 }, 'down');
    near(clampView({ scale: 1, x: 0, y: -300 }, geometry), { scale: 1, x: 0, y: -214 }, 'up');
    // Zoomed ×2 (1200 × 800): x −100…1100, y 0…800.
    near(clampView({ scale: 2, x: 700, y: 500 }, geometry), { scale: 2, x: 600, y: 386 });
  });

  it('the laid-out center is always inside the interval', () => {
    const tiny: Geometry = { ...geometry, image: { width: 20, height: 10 }, center: { x: 500, y: 414 }, natural: null };

    near(clampView(FIT, tiny), FIT);
  });
});

describe('zoom and pan', () => {
  it('zoomAt keeps the point under the cursor where it is', () => {
    const point = { x: 700, y: 500 };
    const zoomed = zoomAt(FIT, point, 2, geometry);

    near(zoomed, { scale: 2, x: -200, y: -86 });
    assert.deepEqual(follow(point, FIT, zoomed), point);
  });

  it('zoomAt stops at the bounds of the scale', () => {
    assert.equal(zoomAt(FIT, { x: 500, y: 414 }, 10, geometry).scale, 4);
    const top = zoomAt(FIT, { x: 500, y: 414 }, 4, geometry);

    near(zoomAt(top, { x: 100, y: 100 }, 2, geometry), top, 'already at the maximum');
    const bottom = zoomAt(FIT, { x: 500, y: 414 }, 0.5, geometry);

    near(bottom, { scale: 0.5, x: 0, y: 0 }, 'half the fit about the center');
    near(zoomAt(bottom, { x: 100, y: 100 }, 0.5, geometry), bottom, 'already at the minimum');
  });

  it('panBy moves until the bound and no further', () => {
    const zoomed = zoomAt(FIT, { x: 500, y: 414 }, 2, geometry);

    near(panBy(zoomed, 50, -30, geometry), { scale: 2, x: 50, y: -30 });
    near(panBy(zoomed, 5000, -5000, geometry), { scale: 2, x: 600, y: -414 });
  });

  it('the pinch keeps the image point under the midpoint of the fingers', () => {
    const base = { view: FIT, mid: { x: 650, y: 414 }, dist: 100 };
    const pinched = pinchView(base, { x: 650, y: 414 }, 200, geometry);

    near(pinched, { scale: 2, x: -150, y: 0 });
    assert.deepEqual(follow(base.mid, FIT, pinched), base.mid);

    const moved = pinchView(base, { x: 700, y: 450 }, 200, geometry);

    assert.deepEqual(follow(base.mid, FIT, moved), { x: 700, y: 450 });
  });

  it('the one-finger zoom doubles every 120 px down and halves every 120 px up, about the tap', () => {
    const anchor = { x: 600, y: 300 };
    const down = zoomDragView({ view: FIT, anchor }, 120, geometry);

    assert.ok(Math.abs(down.scale - 2) < 1e-9);
    assert.deepEqual(follow(anchor, FIT, down), anchor);
    near(zoomDragView({ view: down, anchor }, -120, geometry), FIT);
    assert.ok(Math.abs(zoomDragView({ view: FIT, anchor }, 60, geometry).scale - Math.SQRT2) < 1e-9);
    assert.ok(Math.abs(zoomDragView({ view: FIT, anchor }, -120, geometry).scale - 0.5) < 1e-9, 'up from the fit — half');
    assert.ok(Math.abs(zoomDragView({ view: FIT, anchor }, -500, geometry).scale - 0.5) < 1e-9, 'never below half');
  });

  it('a double tap from the fit zooms into its point; from any other view it returns to the fit', () => {
    const point = { x: 300, y: 300 };
    const zoomed = doubleTapTarget(FIT, point, geometry);

    assert.equal(zoomed.scale, DOUBLE_TAP_SCALE);
    assert.deepEqual(follow(point, FIT, zoomed), point);
    near(doubleTapTarget(zoomed, { x: 900, y: 700 }, geometry), FIT, 'zoomed in');
    near(doubleTapTarget({ scale: 0.5, x: 0, y: 0 }, point, geometry), FIT, 'zoomed out');
    near(doubleTapTarget({ scale: 1, x: 100, y: 0 }, point, geometry), FIT, 'merely dragged');
  });
});

describe('the wheel', () => {
  it('pixels from lines and pages, Shift turns the wheel horizontal', () => {
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }), { x: 0, y: 48 });
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }), { x: 0, y: 400 });
    assert.deepEqual(wheelPixels({ deltaX: 5, deltaY: -7, deltaMode: 0 }), { x: 5, y: -7 });
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 20, deltaMode: 0, shiftKey: true }), { x: 20, y: 0 });
    assert.deepEqual(wheelPixels({ deltaX: 4, deltaY: 20, deltaMode: 0, shiftKey: true }), { x: 4, y: 20 });
  });

  it('away zooms out, toward zooms in; a notch is capped, fine steps stay fine', () => {
    assert.ok(Math.abs(wheelZoomFactor(100) - Math.exp(-0.4)) < 1e-9);
    assert.ok(Math.abs(wheelZoomFactor(-100) - Math.exp(0.4)) < 1e-9);
    assert.ok(Math.abs(wheelZoomFactor(10) - Math.exp(-0.1)) < 1e-9);
    assert.equal(wheelZoomFactor(0), 1);
  });
});

describe('the animation', () => {
  it('interpolates the scale geometrically and the offset linearly', () => {
    const to = { scale: 4, x: 100, y: -50 };

    near(interpolateView(FIT, to, 0), FIT);
    near(interpolateView(FIT, to, 1), to);
    near(interpolateView(FIT, to, 0.5), { scale: 2, x: 50, y: -25 });
  });
});

describe('the pointers', () => {
  const at = (x: number, y: number): Point => ({ x, y });

  it('one finger pans step by step; lifting after a move is no tap', () => {
    const g = new ZoomGestures(geometry);

    assert.deepEqual(g.down(1, 'touch', at(500, 500), 0), []);
    assert.deepEqual(g.move(1, at(520, 530), 16), [{ kind: 'view', view: { scale: 1, x: 20, y: 30 } }]);
    assert.deepEqual(g.move(1, at(530, 530), 32), [{ kind: 'view', view: { scale: 1, x: 30, y: 30 } }]);
    assert.deepEqual(g.up(1, 48), []);
    assert.equal(g.active, false);
  });

  it('a step the clamp eats leaves no debt', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(500, 500), 0);
    g.move(1, at(900, 500), 16);
    near(g.view, { scale: 1, x: 300, y: 0 }, 'stopped at the bound');
    g.move(1, at(890, 500), 32);
    near(g.view, { scale: 1, x: 290, y: 0 }, 'comes back at once');
  });

  it('a clean tap is a tap; two taps are a double tap that animates', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(300, 300), 0);
    assert.deepEqual(g.up(1, 80), [{ kind: 'tap', point: at(300, 300) }]);
    g.down(2, 'touch', at(305, 296), 200);
    const effects = g.up(2, 260);

    assert.equal(effects.length, 1);
    assert.equal(effects[0].kind, 'animate');
    assert.ok(effects[0].kind === 'animate' && sameView(effects[0].view, doubleTapTarget(FIT, at(305, 296), geometry)));
    // The animation's end is reported back; a third tap is a first tap again.
    g.setView(doubleTapTarget(FIT, at(305, 296), geometry));
    g.down(3, 'touch', at(305, 296), 400);
    assert.deepEqual(g.up(3, 460), [{ kind: 'tap', point: at(305, 296) }]);
  });

  it('a second tap too late or too far is a first tap', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(300, 300), 0);
    g.up(1, 50);
    g.down(2, 'touch', at(300, 300), 400);
    assert.deepEqual(g.up(2, 450), [{ kind: 'tap', point: at(300, 300) }]);
    g.down(3, 'touch', at(400, 300), 500);
    assert.deepEqual(g.up(3, 550), [{ kind: 'tap', point: at(400, 300) }]);
  });

  it('a second tap that stays down and moves is the one-finger zoom about the tap', () => {
    const g = new ZoomGestures(geometry);
    const tap = at(600, 300);

    g.down(1, 'touch', tap, 0);
    g.up(1, 50);
    g.down(2, 'touch', at(602, 302), 200);
    // Within the slop nothing happens yet — the finger may still lift for a double tap.
    assert.deepEqual(g.move(2, at(603, 306), 216), []);
    // Past the slop the zoom begins from here: the first step itself is no jump.
    assert.deepEqual(g.move(2, at(603, 316), 232), []);
    near(g.view, FIT);
    const [effect] = g.move(2, at(603, 436), 300);

    assert.equal(effect.kind, 'view');
    assert.ok(Math.abs(g.view.scale - 2) < 1e-9, 'doubled 120 px down');
    assert.deepEqual(follow(at(602, 302), FIT, g.view), at(602, 302));
    g.move(2, at(603, 316), 400);
    near(g.view, FIT, 'back up — back to the start');
    g.move(2, at(603, 196), 450);
    assert.ok(Math.abs(g.view.scale - 0.5) < 1e-9, 'above the start — out, to half the fit');
    g.move(2, at(603, 76), 470);
    assert.ok(Math.abs(g.view.scale - 0.5) < 1e-9, 'and never below');
    assert.deepEqual(g.up(2, 500), [], 'no double tap at the end of the zoom');
  });

  it('a second tap held still and released is a double tap', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(300, 300), 0);
    g.up(1, 50);
    g.down(2, 'touch', at(300, 300), 200);
    const effects = g.up(2, 900);

    assert.equal(effects[0]?.kind, 'animate');
  });

  it('two fingers pinch about their midpoint', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(400, 414), 0);
    g.down(2, 'touch', at(600, 414), 10);
    const [effect] = g.move(2, at(800, 414), 30);

    assert.equal(effect.kind, 'view');
    near(g.view, { scale: 2, x: 100, y: 0 });
    assert.deepEqual(follow(at(500, 414), FIT, g.view), at(600, 414), 'the point under the midpoint stays under it');
  });

  it('2 → 1 → 2: every change of the fingers re-bases from the view of the moment, without a jump', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(400, 414), 0);
    g.down(2, 'touch', at(600, 414), 10);
    g.move(2, at(800, 414), 30);
    const pinched = g.view;

    // One finger lifts: the other pans from where it is.
    assert.deepEqual(g.up(1, 40), []);
    near(g.view, pinched, 'lifting a finger moves nothing');
    assert.deepEqual(g.move(2, at(810, 424), 50), [{ kind: 'view', view: { scale: 2, x: 110, y: 10 } }]);

    // A finger lands again: the pinch starts from this view and these positions.
    g.down(3, 'touch', at(600, 414), 60);
    near(g.view, { scale: 2, x: 110, y: 10 }, 'landing a finger moves nothing');
    assert.deepEqual(g.move(3, at(600, 414), 70), [{ kind: 'view', view: { scale: 2, x: 110, y: 10 } }], 'a move that moved nothing changes nothing');
    const before = g.view;
    const mid = at(705, 419);

    g.move(3, at(590, 414), 80);
    assert.ok(Math.abs(g.view.scale - 2 * (Math.hypot(220, 10) / Math.hypot(210, 10))) < 1e-9);
    assert.deepEqual(follow(mid, before, g.view), at(700, 419));

    // Both lift: no tap comes out of a session that had two fingers.
    assert.deepEqual(g.up(2, 90), []);
    assert.deepEqual(g.up(3, 100), []);
    assert.equal(g.active, false);
  });

  it('a session with two fingers that never moved is still no tap and no double tap', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(300, 300), 0);
    g.down(2, 'touch', at(320, 300), 5);
    assert.deepEqual(g.up(2, 50), []);
    assert.deepEqual(g.up(1, 60), []);
    g.down(3, 'touch', at(300, 300), 100);
    assert.deepEqual(g.up(3, 150), [{ kind: 'tap', point: at(300, 300) }], 'the next tap is a first tap');
  });

  it('a third finger neither moves the view nor breaks the pinch', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'touch', at(400, 414), 0);
    g.down(2, 'touch', at(600, 414), 10);
    g.move(2, at(800, 414), 30);
    const pinched = g.view;

    g.down(4, 'touch', at(100, 100), 40);
    assert.deepEqual(g.move(4, at(150, 150), 50), []);
    near(g.view, pinched);
  });

  it('a mouse: a drag pans and is no click, a still press is a click', () => {
    const g = new ZoomGestures(geometry);

    g.down(1, 'mouse', at(500, 500), 0);
    g.move(1, at(540, 500), 16);
    assert.deepEqual(g.up(1, 100), []);
    g.down(2, 'mouse', at(500, 500), 500);
    assert.deepEqual(g.up(2, 560), [{ kind: 'tap', point: at(500, 500) }]);
  });

  it('the wheel pans and zooms about the cursor', () => {
    const g = new ZoomGestures(geometry);

    near(g.pan(-10, -20), { scale: 1, x: -10, y: -20 });
    near(g.zoomBy(at(700, 500), 2), zoomAt({ scale: 1, x: -10, y: -20 }, at(700, 500), 2, geometry));
  });

  it('a new geometry keeps the view within the new bounds; reset returns to the fit', () => {
    const g = new ZoomGestures(geometry, { scale: 2, x: 600, y: 0 });

    near(g.setGeometry({ ...geometry, stage: { width: 600, height: 800 } }), { scale: 2, x: 400, y: 0 });
    g.reset();
    near(g.view, FIT);
  });
});
