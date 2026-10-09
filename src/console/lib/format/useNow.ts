// The current time for relative labels ("running 2h 36m"), refreshed on a
// shared timer: one interval per period, every subscriber re-renders on the
// same tick. The list needs minutes, not seconds — the default period.

import { useEffect, useState } from 'react';

const MINUTE = 60_000;

type Clock = { now: Date; listeners: Set<(now: Date) => void>; timer: ReturnType<typeof setInterval> | null };

const clocks = new Map<number, Clock>();

function subscribe(periodMs: number, listener: (now: Date) => void): () => void {
  let clock = clocks.get(periodMs);

  if (!clock) {
    clock = { now: new Date(), listeners: new Set(), timer: null };
    clocks.set(periodMs, clock);
  }

  clock.listeners.add(listener);

  if (!clock.timer) {
    const tick = () => {
      const current = clocks.get(periodMs);

      if (!current) {
        return;
      }

      current.now = new Date();

      for (const fn of current.listeners) {
        fn(current.now);
      }
    };

    clock.timer = setInterval(tick, periodMs);
  }

  return () => {
    const current = clocks.get(periodMs);

    if (!current) {
      return;
    }

    current.listeners.delete(listener);

    if (current.listeners.size === 0 && current.timer) {
      clearInterval(current.timer);
      clocks.delete(periodMs);
    }
  };
}

export function useNow(periodMs: number = MINUTE): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => subscribe(periodMs, setNow), [periodMs]);

  return now;
}
