// On-the-fly transformation of app source modules: .tsx/.ts/.jsx/.js served
// as browser ESM via esbuild.transform (jsx automatic, es2022). "Update =
// overwrite the file" is the contract, so the cache key is mtime+size and
// responses are no-store — F5 after an edit must show the new code.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { transform } from 'esbuild';

const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
};

export function isTransformableModule(filename: string): boolean {
  return path.extname(filename).toLowerCase() in LOADERS;
}

type CacheEntry = { key: string; code: string };

const cache = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 500;

/**
 * The browser-ready ESM for one app source file. A syntax error becomes a
 * loud module (throws on evaluation with the esbuild message) rather than a
 * broken response: the app fails visibly in the console, the platform edge
 * stays a clean 200.
 */
export async function transformAppModule(absPath: string, stats: Stats): Promise<string> {
  const key = `${stats.mtimeMs}:${stats.size}`;
  const cached = cache.get(absPath);

  if (cached && cached.key === key) {
    return cached.code;
  }

  const source = await fs.readFile(absPath, 'utf8');
  const loader = LOADERS[path.extname(absPath).toLowerCase()] ?? 'js';

  let code: string;

  try {
    const result = await transform(source, {
      loader,
      jsx: 'automatic',
      target: 'es2022',
      format: 'esm',
      sourcefile: path.basename(absPath),
    });

    code = result.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    code = `throw new SyntaxError(${JSON.stringify(`[balabash apps] ${path.basename(absPath)}: ${message}`)});\n`;
  }

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  cache.set(absPath, { key, code });

  return code;
}
