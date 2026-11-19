// The built bundle against the sources it is built from. A restart boots
// whatever dist/ holds: without a bundle it has nothing to boot, and a
// bundle older than the newest source boots the code as it was at the last
// build. Whoever requests a restart asks here first.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// What `npm run build` turns into the bundle, from the root of the
// repository.
const BUNDLE_SOURCES = ['src', 'agents', 'tools', 'build', 'prisma', 'mcp-servers', 'package.json', 'supervisor.js'];

const BUNDLE_ENTRY = path.join('dist', 'app.js');

// missing — there is no bundle; stale — a source changed after the bundle
// was built; current — the bundle is newer than every source.
export type BundleState = 'current' | 'stale' | 'missing';

async function newestMtimeMs(target: string): Promise<number> {
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
  const nested = await Promise.all(entries.map(entry => newestMtimeMs(path.join(target, entry.name))));

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

  const sources = await Promise.all(BUNDLE_SOURCES.map(source => newestMtimeMs(path.join(root, source))));

  return Math.max(...sources) > bundle.mtimeMs ? 'stale' : 'current';
}
