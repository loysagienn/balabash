// The console bundle (src/console → dist/console): the browser SPA served by
// the core on CONSOLE_DOMAIN (src/api/console.ts). The core process never
// holds a byte of it — the server reads dist/console/manifest.json on every
// shell request, so a new build goes live with the next page load, without
// a restart.
//
// Layout of dist/console:
//   assets/<name>-<hash>.{js,css,…}  content-addressed, served immutable;
//   manifest.json                    which assets the shell points at NOW.
//
// The manifest is the switch: it is written (atomically, tmp + rename) only
// after esbuild has finished every asset, so a shell can never reference a
// half-written file. Assets of previous builds are left in place for a day —
// a tab opened before the build still resolves its chunks — then pruned.

import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('dist', 'console');
const ASSETS_DIR = path.join(OUT_DIR, 'assets');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');
const ENTRY = './src/console/main.tsx';

const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} NODE_ENV
 * @returns {esbuild.BuildOptions}
 */
function getOptions(NODE_ENV) {
  return {
    entryPoints: { main: ENTRY },
    bundle: true,
    outdir: ASSETS_DIR,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    splitting: true,
    metafile: true,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    loader: {
      '.woff2': 'file',
      '.woff': 'file',
      '.svg': 'file',
      '.png': 'file',
    },
    define: { 'process.env.NODE_ENV': JSON.stringify(NODE_ENV) },
    minify: NODE_ENV === 'production',
    sourcemap: true,
    logLevel: 'info',
  };
}

/**
 * Derives the manifest from the metafile: the entry's JS and its CSS bundle,
 * as names relative to assets/.
 * @param {esbuild.Metafile} metafile
 */
function manifestFromMetafile(metafile) {
  const entryOutput = Object.entries(metafile.outputs).find(([, output]) => output.entryPoint === ENTRY.replace(/^\.\//, ''));

  if (!entryOutput) {
    throw new Error(`console build: no output for entry ${ENTRY}`);
  }

  const [jsPath, output] = entryOutput;
  const toAsset = p => path.relative(ASSETS_DIR, path.resolve(p));
  // The font files of this build (styles/fonts.css → file loader): the shell
  // preloads the main faces by these names.
  const fonts = Object.keys(metafile.outputs)
    .filter(p => p.endsWith('.woff2'))
    .map(toAsset)
    .sort();

  return {
    builtAt: new Date().toISOString(),
    js: toAsset(jsPath),
    css: output.cssBundle ? toAsset(output.cssBundle) : null,
    fonts,
  };
}

/**
 * Removes assets of past builds: anything not produced by this build and
 * older than PRUNE_AFTER_MS. Never touches the current build's files.
 * @param {Set<string>} keep asset names of the current build
 */
async function pruneOldAssets(keep) {
  const now = Date.now();
  const names = await fs.readdir(ASSETS_DIR).catch(() => []);

  for (const name of names) {
    if (keep.has(name)) {
      continue;
    }

    const file = path.join(ASSETS_DIR, name);
    const stats = await fs.stat(file).catch(() => null);

    if (stats && now - stats.mtimeMs > PRUNE_AFTER_MS) {
      await fs.rm(file, { force: true });
    }
  }
}

/**
 * @param {esbuild.BuildResult} result
 */
async function publish(result) {
  if (!result.metafile) {
    return;
  }

  const manifest = manifestFromMetafile(result.metafile);
  const produced = new Set(Object.keys(result.metafile.outputs).map(p => path.relative(ASSETS_DIR, path.resolve(p))));

  // Atomic switch: write beside, then rename over.
  const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;

  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(tmp, MANIFEST_PATH);

  await pruneOldAssets(produced);

  console.log(`[console] published ${manifest.js}${manifest.css ? ` + ${manifest.css}` : ''}`);
}

/**
 * One-shot build (production) or a watching context (development): every
 * successful (re)build publishes a fresh manifest; a failed one logs and
 * leaves the previous manifest — and the live console — untouched.
 * @param {string} NODE_ENV
 * @param {boolean} watch
 */
export async function buildConsole(NODE_ENV, watch) {
  await fs.mkdir(ASSETS_DIR, { recursive: true });

  const options = getOptions(NODE_ENV);

  if (!watch) {
    const result = await esbuild.build(options);

    await publish(result);

    return;
  }

  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'console-manifest',
        setup(build) {
          build.onEnd(async result => {
            if (result.errors.length === 0) {
              await publish(result);
            }
          });
        },
      },
    ],
  });

  await ctx.watch();
}
