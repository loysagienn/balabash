// What a let-go drag does and how long it takes. The drag is read as a
// progress 0…1 toward its end (a page swept off the screen, a sheet pushed
// down out of the window) over an extent in px; the lift's velocity is in
// px per ms, positive toward the end. A fling decides by its direction and
// runs on at its own speed — as fast as the finger was, with no floor —
// though never longer than the full way takes; a slow let-go decides by
// where it stopped — past a third, it goes on — and takes the ordinary
// time, eased a little for a short way, so a page let go near its place
// settles rather than snaps.

// A lift at this speed or faster is a fling.
export const FLING_PX_MS = 0.3;
// Past this progress a slow let-go goes on; before it, it comes back.
export const COMMIT_AT = 1 / 3;
// The time of the full way at the ordinary pace, ms; a fling may be faster, never slower.
export const SETTLE_MS = 320;
// A slow let-go takes at least this share of the ordinary time, however short the way.
export const SETTLE_SHORT_SHARE = 0.6;

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
  const fling = Math.abs(velocity) >= FLING_PX_MS;
  const target: 0 | 1 = fling ? (velocity > 0 ? 1 : 0) : p > COMMIT_AT ? 1 : 0;

  if (reduced) {
    return { target, duration: 0 };
  }

  const remaining = Math.abs(target - p) * extent;

  if (remaining === 0) {
    return { target, duration: 0 };
  }

  const duration = fling ? Math.min(SETTLE_MS, remaining / Math.abs(velocity)) : SETTLE_MS * Math.max(SETTLE_SHORT_SHARE, remaining / extent);

  return { target, duration: Math.round(duration) };
}
