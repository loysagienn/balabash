// Which way a finger is going. A drag is nothing until it has left the
// slop around its start; then it is horizontal when its horizontal travel
// clearly exceeds the vertical one, vertical in the mirror case, and
// undecided in the cone between — until the travel is long enough that
// waiting makes no sense: the page's own vertical scroll is the safer
// reading of an ambiguous drag (the browser would have taken it by then
// anyway). A decision, once made, holds for the gesture.

export type Axis = 'x' | 'y';

// A finger's travel within this of its start is a tap or a tremor, not a drag.
export const SLOP_PX = 8;
// One axis wins when its travel is this many times the other's (1.5 — a
// cone of about 34° around the axis).
export const AXIS_RATIO = 1.5;
// Travel this long without a clear axis is read as vertical.
export const UNDECIDED_MAX_PX = 24;

export function lockAxis(dx: number, dy: number): Axis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (Math.max(ax, ay) < SLOP_PX) {
    return null;
  }

  if (ax >= ay * AXIS_RATIO) {
    return 'x';
  }

  if (ay >= ax * AXIS_RATIO) {
    return 'y';
  }

  return Math.hypot(dx, dy) >= UNDECIDED_MAX_PX ? 'y' : null;
}
