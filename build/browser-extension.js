// The browser extension (src/browser-extension → dist/browser-extension):
// the unpacked extension a user loads into Chrome ("Load unpacked" on
// chrome://extensions) to link the browser to this server.
//
// Layout of dist/browser-extension: manifest.json and options.html as they
// are in the source, background.js (the service worker, one ES module) and
// options.js. Not minified: Chrome shows the user the code it runs.
// Rides the full build; on its own it is `npm run build-extension`.

import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const SRC_DIR = path.resolve('src', 'browser-extension');
const OUT_DIR = path.resolve('dist', 'browser-extension');

export async function buildBrowserExtension() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: { background: path.join(SRC_DIR, 'background.ts'), options: path.join(SRC_DIR, 'options.ts') },
    bundle: true,
    outdir: OUT_DIR,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    legalComments: 'inline',
    logLevel: 'info',
  });

  for (const name of ['manifest.json', 'options.html']) {
    await fs.copyFile(path.join(SRC_DIR, name), path.join(OUT_DIR, name));
  }

  // The license of the Playwright modules travels with the bundle.
  await fs.copyFile(path.join(SRC_DIR, 'playwright', 'LICENSE'), path.join(OUT_DIR, 'LICENSE-playwright.txt'));
  await fs.copyFile(path.join(SRC_DIR, 'playwright', 'NOTICE'), path.join(OUT_DIR, 'NOTICE-playwright.txt'));
}
