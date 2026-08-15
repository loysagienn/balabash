import * as esbuild from 'esbuild';

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

export async function buildServer(NODE_ENV, APP_VERSION, watchDelay) {
  const options = getOptions(NODE_ENV, APP_VERSION);

  if (NODE_ENV === 'production') {
    await esbuild.build(options);
  } else {
    const ctx = await esbuild.context(options);
    await ctx.watch(watchDelay != null ? { delay: watchDelay } : undefined);
  }
}
