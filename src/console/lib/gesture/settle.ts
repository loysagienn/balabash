// What a let-go drag does and how long it takes. The drag is read as a
// progress 0…1 toward its end (a page swept off the screen, a sheet pushed
// down out of the window) over an extent in px; the lift's velocity is in
// px per ms, positive toward the end. A fling decides by its direction; a
// slow let-go by where it stopped — past the half, it goes on. The settle
// runs at the finger's speed where there is one (never faster than the
// shortest time, never slower than the full animation), and a slow let-go
// takes the ordinary pace scaled to the distance left.

// A lift at this speed or faster is a fling.
export const FLING_PX_MS = 0.3;
// Past this progress a slow let-go goes on; before it, it comes back.
export const COMMIT_AT = 0.5;
// The bounds of the settle's duration, ms.
export const SETTLE_MIN_MS = 100;
export const SETTLE_MAX_MS = 320;

export type Settle = { target: 0 | 1; duration: number };

export function settle({
  progress,
  velocity,
  extent,
  reduced = false,
}: {
  progress: number;
  velocity: number;
  extent: number;
  reduced?: boolean;
}): Settle {
  const p = Math.max(0, Math.min(1, progress));
  const target: 0 | 1 = Math.abs(velocity) >= FLING_PX_MS ? (velocity > 0 ? 1 : 0) : p > COMMIT_AT ? 1 : 0;

  if (reduced) {
    return { target, duration: 0 };
  }

  const remaining = Math.abs(target - p) * extent;
  // The speed toward the target: the fling's own, or the ordinary pace.
  const along = target === 1 ? velocity : -velocity;
  const pace = Math.max(along, extent / SETTLE_MAX_MS);
  const duration = Math.round(Math.max(SETTLE_MIN_MS, Math.min(SETTLE_MAX_MS, remaining / pace)));

  return { target, duration: remaining === 0 ? 0 : duration };
}
