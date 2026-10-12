// The task bodies: a registry row of kind 'code' joins its run(ctx) body by
// slug, and the body is a file of the task's workspace —
// data/workspace/<userId>/tasks/<slug>.ts, imported fresh at every fire
// (src/capabilities/extensions.ts): no build, no restart, an edit is live at
// the next moment. A broken file fails that run loudly (system.exception),
// never the boot. A task is a workspace notion, so its body lives with the
// workspace and outside the repository; the contract is src/schedule/AGENTS.md.
//
// The tasks/ directory is an ES module scope of its own: the loader keeps a
// package.json with "type": "module" there before importing, so a body's
// `export` is read as ESM whatever package.json sits higher up (the
// workspace area may carry its own, e.g. "type": "commonjs" of an npm init
// for shared packages — Node takes the nearest one).
//
// A row whose file is absent is a SLEEPING task: the heart does not arm it
// and run_task rejects it synchronously; the boot sweep journals a
// system.exception per sleeping task so the gap is loud, not silent.

import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { importExtensionModule } from '../capabilities/extensions.ts';
import { workspaceTasksDir } from '../workspace/layout.ts';
import type { TaskRun } from './contract.ts';

const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;

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

/** The workspace task file of a slug, by convention — whether it exists or not. */
export function workspaceTaskFile(userId: string, slug: string): string {
  return path.join(workspaceTasksDir(userId), `${slug}.ts`);
}

// The body file of a registry row, without loading it, or null (sleeping).
// The slug pattern is what keeps the path honest — a registry slug never
// carries separators.
export async function locateTaskBody(userId: string, slug: string): Promise<string | null> {
  if (!SLUG_PATTERN.test(slug)) {
    return null;
  }

  const file = workspaceTaskFile(userId, slug);
  const stats = await stat(file).catch(() => null);

  return stats?.isFile() ? file : null;
}

export async function hasTaskBody(userId: string, slug: string): Promise<boolean> {
  return (await locateTaskBody(userId, slug)) !== null;
}

// Makes the body's directory an ES module scope: its package.json gets
// "type": "module" — written when absent, corrected when it says otherwise
// (its other fields kept).
async function ensureModuleScope(directory: string): Promise<void> {
  const file = path.join(directory, 'package.json');
  let manifest: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>;

      if (manifest.type === 'module') {
        return;
      }
    }
  } catch {
    // Absent or unreadable: written afresh below.
  }

  await writeFile(file, `${JSON.stringify({ ...manifest, type: 'module' }, null, 2)}\n`);
}

/** Imports a body file fresh and validates its module: only run(ctx). */
export async function loadTaskBody(file: string): Promise<TaskRun> {
  await ensureModuleScope(path.dirname(file));

  return validateTaskModule(file, await importExtensionModule(file));
}
