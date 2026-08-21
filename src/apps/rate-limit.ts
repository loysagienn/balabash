// In-memory fixed-window rate limit by IP for the public surface of the
// apps domain (design №11): the public slug pages, their assets and the
// public data gateway. A personal system: memory suffices, a restart
// resets the windows — both acceptable.

const WINDOW_MS = 60 * 1000;
const MAX_HITS_PER_WINDOW = 240;

// Memory backstop: when this many IPs opened windows inside one minute the
// surface is being flooded — refusing new IPs beats growing without bound.
const MAX_TRACKED_IPS = 10_000;

type HitWindow = {
  startedAt: number;
  hits: number;
};

const windows = new Map<string, HitWindow>();

export function allowPublicHit(ip: string): boolean {
  const now = Date.now();
  const entry = windows.get(ip);

  if (entry && now - entry.startedAt < WINDOW_MS) {
    entry.hits += 1;

    return entry.hits <= MAX_HITS_PER_WINDOW;
  }

  if (windows.size >= MAX_TRACKED_IPS) {
    for (const [key, window] of windows) {
      if (now - window.startedAt >= WINDOW_MS) {
        windows.delete(key);
      }
    }

    if (windows.size >= MAX_TRACKED_IPS) {
      return false;
    }
  }

  windows.set(ip, { startedAt: now, hits: 1 });

  return true;
}
