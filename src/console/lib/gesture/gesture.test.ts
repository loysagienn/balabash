import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AXIS_RATIO, SLOP_PX, UNDECIDED_MAX_PX, lockAxis } from './axis.ts';
import { Drag } from './drag.ts';
import { COMMIT_AT, FLING_PX_MS, SETTLE_MS, SETTLE_SHORT_SHARE, settle } from './settle.ts';
import { STILL_MS, VelocityTracker } from './velocity.ts';

describe('gesture — the axis', () => {
  it('decides nothing within the slop', () => {
    assert.equal(lockAxis(0, 0), null);
    assert.equal(lockAxis(SLOP_PX - 1, 0), null);
    assert.equal(lockAxis(0, -(SLOP_PX - 1)), null);
  });

  it('takes the axis whose travel clearly exceeds the other’s', () => {
    assert.equal(lockAxis(12, 0), 'x');
    assert.equal(lockAxis(-12, 4), 'x');
    assert.equal(lockAxis(0, 12), 'y');
    assert.equal(lockAxis(4, -12), 'y');
    assert.equal(lockAxis(9, 6), 'x');
    assert.equal(lockAxis(6, 9), 'y');
    assert.equal(lockAxis(12, 12 / AXIS_RATIO), 'x');
  });

  it('waits in the cone between, then reads a long ambiguous drag as vertical', () => {
    assert.equal(lockAxis(10, 9), null);
    assert.equal(lockAxis(9, 10), null);
    assert.equal(lockAxis(UNDECIDED_MAX_PX, UNDECIDED_MAX_PX), 'y');
  });
});

describe('gesture — the velocity', () => {
  it('is the slope over the last window of samples', () => {
    const tracker = new VelocityTracker();

    tracker.add(0, 0);
    tracker.add(50, 10);
    tracker.add(100, 20);
    tracker.add(150, 40);
    tracker.add(200, 60);
    // The window: 100…200 — 40 px over 100 ms.
    assert.equal(tracker.velocity(210), 0.4);
    // Fewer than two samples: nothing to read.
    assert.equal(new VelocityTracker().velocity(0), 0);
  });

  it('is zero after the finger stopped, and reads the direction', () => {
    const tracker = new VelocityTracker();

    tracker.add(0, 100);
    tracker.add(16, 80);
    tracker.add(32, 60);
    assert.ok(tracker.velocity(40) < 0);
    assert.equal(tracker.velocity(32 + STILL_MS), 0);
  });

  it('reads the last two samples when only the last is within the window', () => {
    const tracker = new VelocityTracker();

    tracker.add(0, 0);
    tracker.add(500, 100);
    tracker.add(520, 110);
    assert.equal(tracker.velocity(525), 0.5);
  });
});

describe('gesture — the settle', () => {
  it('decides by the fling, else by the third', () => {
    assert.equal(settle({ progress: 0.2, velocity: FLING_PX_MS, extent: 390 }).target, 1);
    assert.equal(settle({ progress: 0.9, velocity: -FLING_PX_MS, extent: 390 }).target, 0);
    assert.equal(settle({ progress: COMMIT_AT + 0.01, velocity: 0, extent: 390 }).target, 1);
    assert.equal(settle({ progress: COMMIT_AT, velocity: 0.1, extent: 390 }).target, 0);
  });

  it('runs a fling at the finger’s speed with no floor, and a slow let-go at the ordinary time', () => {
    // 312 px left at 2 px/ms — 156 ms; at 20 px/ms — 16 ms.
    assert.deepEqual(settle({ progress: 0.2, velocity: 2, extent: 390 }), { target: 1, duration: 156 });
    assert.deepEqual(settle({ progress: 0.2, velocity: 20, extent: 390 }), { target: 1, duration: 16 });
    // A fling back from far along: at the fling's speed.
    assert.deepEqual(settle({ progress: 0.9, velocity: -5, extent: 400 }), { target: 0, duration: 72 });
    // A fling barely over the threshold never takes longer than the full way.
    assert.deepEqual(settle({ progress: 0.1, velocity: FLING_PX_MS, extent: 400 }), { target: 1, duration: SETTLE_MS });
    // A slow let-go: the ordinary time scaled to the way left, never under its short share.
    assert.deepEqual(settle({ progress: 0.75, velocity: 0, extent: 400 }), { target: 1, duration: Math.round(SETTLE_MS * SETTLE_SHORT_SHARE) });
    assert.deepEqual(settle({ progress: 0.2, velocity: 0.05, extent: 400 }), { target: 0, duration: Math.round(SETTLE_MS * SETTLE_SHORT_SHARE) });
    assert.deepEqual(settle({ progress: 0.1, velocity: 0, extent: 400 }), { target: 0, duration: Math.round(SETTLE_MS * SETTLE_SHORT_SHARE) });
    assert.deepEqual(settle({ progress: 0.34, velocity: 0, extent: 400 }), { target: 1, duration: Math.round(SETTLE_MS * 0.66) });
    // Nothing left: no time.
    assert.deepEqual(settle({ progress: 0, velocity: 0, extent: 400 }), { target: 0, duration: 0 });
    assert.deepEqual(settle({ progress: 0.3, velocity: 1, extent: 400, reduced: true }), { target: 1, duration: 0 });
  });
});

describe('gesture — the drag', () => {
  it('claims a drag of its axis from the point of the decision and reads the lift', () => {
    const drag = new Drag('x');

    drag.down(100, 100, 0);
    assert.deepEqual(drag.move(104, 101, 16), { kind: 'none' });
    assert.equal(drag.claimed, false);
    assert.deepEqual(drag.move(112, 102, 32), { kind: 'claim', travel: 0, sign: 1 });
    assert.equal(drag.claimed, true);
    assert.deepEqual(drag.move(142, 104, 48), { kind: 'move', travel: 30 });
    assert.deepEqual(drag.move(132, 104, 64), { kind: 'move', travel: 20 });
    // The window of the lift (50 ms before the last move): from 104 at 16 to 132 at 64.
    assert.equal(drag.up(70), (132 - 104) / (64 - 16));
    assert.equal(drag.active, false);
  });

  it('reads a flick’s speed from the touch itself: claimed and lifted within two moves', () => {
    const drag = new Drag('x');

    drag.down(60, 400, 0);
    assert.deepEqual(drag.move(110, 401, 16), { kind: 'claim', travel: 0, sign: 1 });
    assert.deepEqual(drag.move(170, 402, 32), { kind: 'move', travel: 60 });
    // 110 px over 32 ms, read from the touch at 60: a fling, not a slow let-go.
    assert.equal(drag.up(36), (170 - 60) / 32);
  });

  it('says which way the finger went when the axis was decided', () => {
    const drag = new Drag('x');

    drag.down(100, 100, 0);
    assert.deepEqual(drag.move(88, 101, 16), { kind: 'claim', travel: 0, sign: -1 });
    assert.deepEqual(drag.move(78, 101, 32), { kind: 'move', travel: -10 });
  });

  it('lets a drag of the other axis go, and a tap too', () => {
    const drag = new Drag('x');

    drag.down(100, 100, 0);
    assert.deepEqual(drag.move(101, 120, 16), { kind: 'release' });
    assert.deepEqual(drag.move(150, 120, 32), { kind: 'none' });
    assert.equal(drag.up(40), null);

    drag.down(10, 10, 0);
    assert.equal(drag.up(50), null);

    const vertical = new Drag('y');

    vertical.down(0, 0, 0);
    assert.deepEqual(vertical.move(2, 20, 10), { kind: 'claim', travel: 0, sign: 1 });
    assert.deepEqual(vertical.move(2, 50, 20), { kind: 'move', travel: 30 });
    vertical.cancel();
    assert.equal(vertical.active, false);
    assert.equal(vertical.up(30), null);
  });
});
