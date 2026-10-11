// The totals of every workspace's file area — how many files and how many
// bytes, per top-level folder too — for the console's summaries: the Files
// section on Home, the "file area" line of the disk on System, "Project
// files" of a project (its folder is a top-level one). A measurement, not
// a fact of the log: a walk over data/workspace/<userId>/files, repeated on
// a timer by the service below and kept in the process's memory; a reader
// gets the newest one or null before the first walk (the console says
// "measuring"). The walk counts what is on disk — every regular file, the
// hidden and the binary ones included — and never follows a symbolic link
// (a link is not a file of the area, src/workspace/files.ts): the root and
// every node are read with lstat as they are at that moment, not as the
// listing saw them, so a folder or a file replaced by a link since its
// listing is not followed either (the check and the read are two calls —
// a swap between them is the one window left). What the walk cannot read
// (a folder refusing its listing, a file refusing its stat) is counted as
// unreadable and makes the measurement incomplete — a lower bound, never
// a precise zero; what vanished in between is simply gone. A runaway area
// is cut at MAX_ENTRIES and marked incomplete the same way.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileAreaTotalsView } from '../api/contract.ts';
import { workspaceFilesDir, workspaceRoot } from './layout.ts';

export const MEASURE_INTERVAL_MS = 15 * 60_000;
// The walk stops counting here: the area is bigger than the totals can say.
export const MAX_ENTRIES = 1_000_000;

const totals = new Map<string, FileAreaTotalsView>();

export function getFileAreaTotals(userId: string): FileAreaTotalsView | null {
  return totals.get(userId) ?? null;
}

type Counter = { files: number; bytes: number };

// A node that is not there anymore (or whose parent is not a directory
// anymore): gone, not unreadable.
function vanished(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;

  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The totals of one directory tree: the root is a file area (or any
// directory — the tests measure a temporary one). Null when there is no
// such directory, or the root itself is a link.
export async function measureDirectory(root: string, now = new Date()): Promise<FileAreaTotalsView | null> {
  const rootStats = await fs.lstat(root).catch(() => null);

  if (!rootStats?.isDirectory()) {
    return null;
  }

  const total: Counter = { files: 0, bytes: 0 };
  // A Map: a folder may be named like a property of Object ("__proto__").
  const folders = new Map<string, Counter>();
  let entries = 0;
  let complete = true;
  let unreadable = 0;
  // Iterative, deepest last: a deep tree must not grow the call stack.
  const pending: { dir: string; top: string | null }[] = [{ dir: root, top: null }];

  while (pending.length) {
    const { dir, top } = pending.pop()!;

    // The folder as it is now: listed as a directory, it may have become a
    // link (or gone) since — a link is not descended into.
    if (dir !== root) {
      let current;

      try {
        current = await fs.lstat(dir);
      } catch (error) {
        if (!vanished(error)) {
          unreadable += 1;
        }

        continue;
      }

      if (!current.isDirectory()) {
        continue;
      }
    }

    let names;

    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!vanished(error)) {
        unreadable += 1;
      }

      continue;
    }

    for (const entry of names) {
      if (entries >= MAX_ENTRIES) {
        complete = false;
        pending.length = 0;
        break;
      }

      entries += 1;

      const folder = top ?? (entry.isDirectory() ? entry.name : null);

      if (entry.isDirectory()) {
        if (folder !== null && !folders.has(folder)) {
          folders.set(folder, { files: 0, bytes: 0 });
        }

        pending.push({ dir: path.join(dir, entry.name), top: folder });
        continue;
      }

      if (!entry.isFile()) {
        continue; // a symbolic link, a socket: not a file of the area
      }

      // The file as it is now, without following a link it may have become.
      let stats;

      try {
        stats = await fs.lstat(path.join(dir, entry.name));
      } catch (error) {
        if (!vanished(error)) {
          unreadable += 1;
        }

        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      total.files += 1;
      total.bytes += stats.size;

      if (top !== null) {
        let counter = folders.get(top);

        if (!counter) {
          counter = { files: 0, bytes: 0 };
          folders.set(top, counter);
        }

        counter.files += 1;
        counter.bytes += stats.size;
      }
    }
  }

  return { measuredAt: now, files: total.files, bytes: total.bytes, folders: Object.fromEntries(folders), complete: complete && unreadable === 0, unreadable };
}

export async function measureFileAreaTotals(userId: string): Promise<FileAreaTotalsView | null> {
  const measured = await measureDirectory(workspaceFilesDir(userId));

  if (measured) {
    totals.set(userId, measured);
  } else {
    totals.delete(userId);
  }

  return measured;
}

async function listWorkspaceUserIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(workspaceRoot(), { withFileTypes: true });

    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  } catch {
    return []; // no workspace root yet — nothing to measure
  }
}

async function measureAll(): Promise<void> {
  for (const userId of await listWorkspaceUserIds()) {
    try {
      await measureFileAreaTotals(userId);
    } catch (error) {
      console.error(`[file-area-totals] failed to measure the file area of user ${userId}:`, error);
    }
  }
}

// The service: a walk at start (the totals exist seconds after boot), then
// one per interval. Not a log consumer, but it stops like one.
export function startFileAreaTotals(): { name: string; stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout;

  const loop = async () => {
    await measureAll();

    if (!stopped) {
      timer = setTimeout(loop, MEASURE_INTERVAL_MS);
    }
  };

  timer = setTimeout(loop, 0);

  return {
    name: 'file-area-totals',
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// Test seam: forget every measurement.
export function resetFileAreaTotalsForTests(): void {
  totals.clear();
}
