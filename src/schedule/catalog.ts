// The task-body catalog (mirror of capabilities/agent-catalog.ts): bodies
// ship inside the app bundle through the static tasks/index.ts. Modules are
// validated hard at boot — a broken body fails the start and the supervisor
// rolls back to the last good bundle. A registry row (kind='code') whose slug
// is missing here is a SLEEPING task: the heart does not arm it and run_task
// rejects it synchronously; the boot sweep journals a system.exception per
// sleeping task so the gap is loud, not silent.

import { taskModules } from '../../tasks/index.ts';
import type { TaskRun } from './contract.ts';

const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;

let bodies = new Map<string, TaskRun>();

export function loadTasks(): void {
  const loaded = new Map<string, TaskRun>();

  for (const [slug, module] of Object.entries(taskModules)) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`Task slug "${slug}" must match ${SLUG_PATTERN}`);
    }

    const exports = Object.keys(module);

    if (exports.length !== 1 || exports[0] !== 'run') {
      throw new Error(`tasks/${slug} must export only "run"`);
    }

    if (typeof module.run !== 'function') {
      throw new Error(`tasks/${slug} export "run" must be a function`);
    }

    loaded.set(slug, module.run as TaskRun);
  }

  bodies = loaded;

  console.log(`[schedule] task bodies loaded: ${[...bodies.keys()].join(', ') || '(none)'}`);
}

export function getTaskBody(slug: string): TaskRun | null {
  return bodies.get(slug) ?? null;
}
