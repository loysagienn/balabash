// One finger's drag along one axis, from the pointer's events to what the
// gesture's owner needs: nothing while the finger is within the slop,
// the decision of the axis once it leaves it (the owner claims the drag
// when the axis is its own and lets it go otherwise), the travel from the
// point of the decision while it is claimed — so the content starts moving
// from under the finger, not with a jump the size of the slop — and the
// velocity at the lift. The DOM wiring (pointer events, preventDefault,
// capture) is the owner's; this is the arithmetic.

import { lockAxis } from './axis.ts';
import type { Axis } from './axis.ts';
import { VelocityTracker } from './velocity.ts';

export type DragPhase = 'idle' | 'tracking' | 'claimed' | 'released';

export type DragMove =
  // Within the slop, or an axis not the owner's: nothing to do.
  | { kind: 'none' }
  // The drag is the owner's as of this move; the travel begins here.
  | { kind: 'claim'; travel: number }
  // The drag went the other way: the owner lets it go.
  | { kind: 'release' }
  // A claimed drag moved: the travel from the claim, px along the axis.
  | { kind: 'move'; travel: number };

export class Drag {
  private phase: DragPhase = 'idle';
  private startX = 0;
  private startY = 0;
  private origin = 0;
  private readonly tracker = new VelocityTracker();
  private readonly axis: Axis;

  constructor(axis: Axis) {
    this.axis = axis;
  }

  get claimed(): boolean {
    return this.phase === 'claimed';
  }

  get active(): boolean {
    return this.phase === 'tracking' || this.phase === 'claimed';
  }

  down(x: number, y: number, t: number): void {
    this.phase = 'tracking';
    this.startX = x;
    this.startY = y;
    this.tracker.reset();
    this.tracker.add(t, this.along(x, y));
  }

  move(x: number, y: number, t: number): DragMove {
    if (this.phase === 'claimed') {
      this.tracker.add(t, this.along(x, y));

      return { kind: 'move', travel: this.along(x, y) - this.origin };
    }

    if (this.phase !== 'tracking') {
      return { kind: 'none' };
    }

    const axis = lockAxis(x - this.startX, y - this.startY);

    if (axis === null) {
      return { kind: 'none' };
    }

    if (axis !== this.axis) {
      this.phase = 'released';

      return { kind: 'release' };
    }

    this.phase = 'claimed';
    this.origin = this.along(x, y);
    this.tracker.reset();
    this.tracker.add(t, this.origin);

    return { kind: 'claim', travel: 0 };
  }

  // The lift: the velocity along the axis (px/ms) of a claimed drag, null
  // for one that was never claimed.
  up(t: number): number | null {
    const claimed = this.phase === 'claimed';

    this.phase = 'idle';

    return claimed ? this.tracker.velocity(t) : null;
  }

  cancel(): void {
    this.phase = 'idle';
  }

  private along(x: number, y: number): number {
    return this.axis === 'x' ? x : y;
  }
}
