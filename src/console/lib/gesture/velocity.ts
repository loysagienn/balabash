// The speed of a finger at the moment it lifts, in px per ms along one
// axis: the slope over the last stretch of samples — a short window, the
// last few frames at 60 Hz, so the speed is the finger's at the lift and
// not an average over a drag that sped up or slowed down — or over the
// last two samples when the window holds only one; and zero when the
// finger had stopped before lifting — a drag that paused and let go has
// no fling in it, however fast it started.

// Samples older than this before the last one do not count.
export const VELOCITY_WINDOW_MS = 50;
// A finger still for this long before lifting has stopped.
export const STILL_MS = 100;

type Sample = { t: number; v: number };

export class VelocityTracker {
  private samples: Sample[] = [];

  reset(): void {
    this.samples = [];
  }

  add(t: number, v: number): void {
    this.samples.push({ t, v });

    const cut = t - VELOCITY_WINDOW_MS;

    while (this.samples.length > 2 && this.samples[1]!.t < cut) {
      this.samples.shift();
    }
  }

  // The velocity at `now` (the lift's time stamp).
  velocity(now: number): number {
    const samples = this.samples;

    if (samples.length < 2) {
      return 0;
    }

    const last = samples[samples.length - 1]!;

    if (now - last.t >= STILL_MS) {
      return 0;
    }

    const cut = last.t - VELOCITY_WINDOW_MS;
    let first = samples[0]!;

    for (const sample of samples) {
      if (sample.t >= cut) {
        first = sample;
        break;
      }
    }

    if (first === last || last.t === first.t) {
      // Only the last sample is within the window: the one before it is
      // the nearest reading there is.
      const before = samples[samples.length - 2]!;

      return last.t === before.t ? 0 : (last.v - before.v) / (last.t - before.t);
    }

    return (last.v - first.v) / (last.t - first.t);
  }
}
