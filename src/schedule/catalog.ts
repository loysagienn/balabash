// The task-body catalog (mirror of capabilities/agent-catalog.ts). Two
// sources of run(ctx) bodies for a registry row of kind 'code':
//
// - the repository catalog tasks/ — bodies ship inside the app bundle through
//   the static tasks/index.ts, validated hard at boot (a broken body fails
//   the start and the supervisor rolls back to the last good bundle);
// - the workspace: data/workspace/<userId>/tasks/<slug>.ts, imported fresh at
//   every fire (src/capabilities/extensions.ts) — no build, no restart, an
//   edit is live at the next moment. A broken file fails that run loudly
//   (system.exception), never the boot.
//
// The repository wins a slug clash. A row whose slug has neither is a
// SLEEPING task: the heart does not arm it and run_task rejects it
// synchronously; the boot sweep journals a system.exception per sleeping
// task so the gap is loud, not silent.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { taskModules } from '../../tasks/index.ts';
import { importExtensionModule } from '../capabilities/extensions.ts';
import { workspaceTasksDir } from '../workspace/layout.ts';
import type { TaskRun } from './contract.ts';

const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;

let bodies = new Map<string, TaskRun>();

function validateTaskModule(label: string, module: Record<string, unknown>): TaskRun {
  const exports = Object.keys(module);

  if (exports.length !== 1 || exports[0] !== 'run') {
    throw new Error(`${label} must export only "run"`);
  }

  if (typeof module.run !== 'function') {
    throw new Error(`${label} export "run" must be a function`);
  }

  return module.run as TaskRun;
}

export function loadTasks(): void {
  const loaded = new Map<string, TaskRun>();

  for (const [slug, module] of Object.entries(taskModules)) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`Task slug "${slug}" must match ${SLUG_PATTERN}`);
    }

    loaded.set(slug, validateTaskModule(`tasks/${slug}`, module));
  }

  bodies = loaded;

  console.log(`[schedule] task bodies loaded: ${[...bodies.keys()].join(', ') || '(none)'}`);
}

export type TaskBodyLocation = { kind: 'bundle'; run: TaskRun } | { kind: 'workspace'; file: string };

/** The workspace task file of a slug, by convention — whether it exists or not. */
export function workspaceTaskFile(userId: string, slug: string): string {
  return path.join(workspaceTasksDir(userId), `${slug}.ts`);
}

// Where the body of a registry row lives, without loading it: the bundle, a
// workspace file, or nowhere (sleeping). The slug pattern is what keeps the
// workspace path honest — a registry slug never carries separators.
export async function locateTaskBody(userId: string, slug: string): Promise<TaskBodyLocation | null> {
  const bundled = bodies.get(slug);

  if (bundled) {
    return { kind: 'bundle', run: bundled };
  }

  if (!SLUG_PATTERN.test(slug)) {
    return null;
  }

  const file = workspaceTaskFile(userId, slug);
  const stats = await stat(file).catch(() => null);

  return stats?.isFile() ? { kind: 'workspace', file } : null;
}

export async function hasTaskBody(userId: string, slug: string): Promise<boolean> {
  return (await locateTaskBody(userId, slug)) !== null;
}

/** Loads the body at a location; a workspace file is imported fresh and validated like a bundled one. */
export async function loadTaskBody(location: TaskBodyLocation): Promise<TaskRun> {
  if (location.kind === 'bundle') {
    return location.run;
  }

  const module = await importExtensionModule(location.file);

  return validateTaskModule(location.file, module);
}
