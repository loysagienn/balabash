import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';

function getOptions(NODE_ENV, APP_VERSION) {
  /**
   * @type {esbuild.BuildOptions}
   */
  const options = {
    // Object form so both entries land flat in dist/ regardless of source dir.
    entryPoints: {
      app: './src/app.ts',
      'rebuild-threads': './scripts/rebuild-threads.ts',
      'render-context': './scripts/render-context.ts',
    },
    bundle: true,
    outdir: './dist',
    platform: 'node',
    packages: 'external',
    format: 'esm',
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    minify: NODE_ENV === 'production',
    sourcemap: NODE_ENV === 'production',
  };

  return options;
}

// ---------------------------------------------------------------------------
// Vendor bundles of the apps platform (src/apps): the browser ESM the app
// runtime's import map points at. react & co are CJS-only on npm, so the
// whole set is bundled ONCE into vendor-core.js — a single shared react
// instance by construction — and thin facade modules re-export each package
// with real named exports (enumerated here at build time through node's own
// CJS/ESM interop). The facades are what the import map addresses.
// ---------------------------------------------------------------------------

const VENDOR_DIR = './dist/apps-vendor';

// file/ns must stay in sync with VENDOR_MODULES in src/apps/shell.ts.
const VENDOR_PACKAGES = [
  { file: 'react.js', pkg: 'react', ns: 'react' },
  { file: 'react-jsx-runtime.js', pkg: 'react/jsx-runtime', ns: 'jsxRuntime' },
  { file: 'react-dom.js', pkg: 'react-dom', ns: 'reactDom' },
  { file: 'react-dom-client.js', pkg: 'react-dom/client', ns: 'reactDomClient' },
];

async function buildAppsVendor(NODE_ENV, APP_VERSION) {
  await fs.mkdir(VENDOR_DIR, { recursive: true });

  // The one real bundle: every vendor package in a single module, so the
  // internal require('react') of react-dom & co resolves inside the bundle
  // to the one react copy.
  const coreSource = [
    ...VENDOR_PACKAGES.map(({ pkg, ns }) => `import * as ${ns} from ${JSON.stringify(pkg)};`),
    `export { ${VENDOR_PACKAGES.map(({ ns }) => ns).join(', ')} };`,
  ].join('\n');

  await esbuild.build({
    stdin: { contents: coreSource, resolveDir: process.cwd(), sourcefile: 'vendor-core.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: `${VENDOR_DIR}/vendor-core.js`,
    // Always the production react: apps are stamped artifacts, not a react
    // development environment.
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: NODE_ENV === 'production',
  });

  // Facades: named exports enumerated through node's view of the CJS
  // packages (cjs-module-lexer). The ?v pins the facade→core edge to this
  // build under the immutable vendor cache.
  for (const { file, pkg, ns } of VENDOR_PACKAGES) {
    const imported = await import(pkg);
    const names = Object.keys(imported).filter(
      name => name !== 'default' && name !== '__esModule' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
    );

    const facade = [
      `import { ${ns} as m } from ${JSON.stringify(`./vendor-core.js?v=${APP_VERSION}`)};`,
      'const d = m.default ?? m;',
      'export default d;',
      ...names.map(name => `export const ${name} = d[${JSON.stringify(name)}];`),
      '',
    ].join('\n');

    await fs.writeFile(`${VENDOR_DIR}/${file}`, facade);
  }

  // The platform SDK (balabash/data): first-party TS, bundled standalone.
  await esbuild.build({
    entryPoints: { 'balabash-data': './src/apps/sdk/data.ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: VENDOR_DIR,
    minify: NODE_ENV === 'production',
  });
}

export async function buildServer(NODE_ENV, APP_VERSION, watchDelay) {
  const options = getOptions(NODE_ENV, APP_VERSION);

  await buildAppsVendor(NODE_ENV, APP_VERSION);

  if (NODE_ENV === 'production') {
    await esbuild.build(options);
  } else {
    const ctx = await esbuild.context(options);
    await ctx.watch(watchDelay != null ? { delay: watchDelay } : undefined);
  }
}
