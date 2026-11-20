// The built bundle against the sources it is built from. A restart boots
// whatever dist/ holds: without a bundle it has nothing to boot, and a
// bundle older than the newest source boots the code as it was at the last
// build. Whoever requests a restart asks here first.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// What `npm run build` turns into the bundle, from the root of the
// repository.
const BUNDLE_SOURCES = ['src', 'agents', 'build', 'prisma', 'package.json', 'supervisor.js'];

// What lies among the sources and is not of the app's bundle: the console is
// a bundle of its own (dist/console), live with the next page load — a
// restart neither needs it rebuilt nor boots it.
const NOT_OF_THE_BUNDLE = new Set([path.join('src', 'console')]);

const BUNDLE_ENTRY = path.join('dist', 'app.js');

// missing — there is no bundle; stale — a source changed after the bundle
// was built; current — the bundle is newer than every source.
export type BundleState = 'current' | 'stale' | 'missing';

async function newestMtimeMs(root: string, source: string): Promise<number> {
  if (NOT_OF_THE_BUNDLE.has(source)) {
    return 0;
  }

  const target = path.join(root, source);
  let stats;

  try {
    stats = await stat(target);
  } catch {
    return 0;
  }

  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(entry => newestMtimeMs(root, path.join(source, entry.name))));

  return Math.max(stats.mtimeMs, ...nested);
}

// The app runs from the root of its repository, so the root is the working
// directory of the process.
export async function bundleState(root = process.cwd()): Promise<BundleState> {
  let bundle;

  try {
    bundle = await stat(path.join(root, BUNDLE_ENTRY));
  } catch {
    return 'missing';
  }

  // Something else under the name of the bundle is nothing to boot.
  if (!bundle.isFile()) {
    return 'missing';
  }

  const sources = await Promise.all(BUNDLE_SOURCES.map(source => newestMtimeMs(root, source)));

  return Math.max(...sources) > bundle.mtimeMs ? 'stale' : 'current';
}
