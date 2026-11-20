// The tasks with a run in flight, by slug. While a run of a task is still
// going, its next moment is skipped: the heart passes it by, a manual run is
// refused.

const running = new Set<string>();

export function isTaskRunning(slug: string): boolean {
  return running.has(slug);
}

// Takes the task for one run; false when a run of it is already going.
export function claimTask(slug: string): boolean {
  if (running.has(slug)) {
    return false;
  }

  running.add(slug);

  return true;
}

export function releaseTask(slug: string): void {
  running.delete(slug);
}
