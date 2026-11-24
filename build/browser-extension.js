// The browser extension (src/browser-extension → dist/browser-extension):
// the unpacked extension a user loads into Chrome ("Load unpacked" on
// chrome://extensions) to link the browser to this server, and the archive
// of it the console hands out (dist/browser-extension.zip — one folder,
// balabash-agent/, with the extension inside).
//
// An extension belongs to one installation: the console domain is built
// into it — the address its links dial, the only origin whose pages it
// answers (`externally_connectable` of the manifest and the check in
// background.ts). The domain is CONSOLE_DOMAIN of the environment, or of
// the installation's .env when the environment does not name it.
//
// Layout of dist/browser-extension: manifest.json (the source's, with the
// console origin added), the pages (popup.html, consent.html) and icons/ as
// they are in the source, background.js (the service worker, one ES
// module), and for each page its script and its stylesheet (popup.js,
// popup.css, consent.js, consent.css — React and the console's blocks and
// tokens, src/console/ui and src/console/styles, bundled in), theme-boot.js
// (the script of a page's head) and the fonts the stylesheets name. Not
// minified: Chrome shows the user the code it runs.
// Rides the full build; on its own it is `npm run build-extension`.

import dotenv from 'dotenv';
import * as esbuild from 'esbuild';
import { zipSync } from 'fflate';
import fs from 'node:fs/promises';
import path from 'node:path';

const SRC_DIR = path.resolve('src', 'browser-extension');
const OUT_DIR = path.resolve('dist', 'browser-extension');
// The fonts of the console's stylesheet, which the pages are drawn with.
const FONTS_DIR = path.resolve('src', 'console', 'styles', 'fonts');
// The pages of the extension: the popup of the toolbar button and the
// window that asks the user about a tab.
const PAGES = ['popup.html', 'consent.html'];
// The folder the archive unpacks into.
const ARCHIVE_ROOT = 'balabash-agent';

// CONSOLE_DOMAIN of the environment, else of .env; '' when neither names it.
export async function readConsoleDomain() {
  const fromEnvironment = process.env.CONSOLE_DOMAIN?.trim();

  if (fromEnvironment) {
    return fromEnvironment;
  }

  const file = await fs.readFile(path.resolve('.env')).catch(() => null);

  return file ? (dotenv.parse(file).CONSOLE_DOMAIN ?? '').trim() : '';
}

async function filesOf(dir, prefix = '') {
  const files = {};

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      Object.assign(files, await filesOf(path.join(dir, entry.name), name));
    } else {
      files[name] = new Uint8Array(await fs.readFile(path.join(dir, entry.name)));
    }
  }

  return files;
}

// `consoleOrigin` — https://<domain>, the pages the extension answers;
// `serverUrl` — wss://<domain>, where it dials. A stand names its own pair
// and its own `outDir`.
export async function buildBrowserExtension({ consoleOrigin, serverUrl, outDir = OUT_DIR }) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: {
      background: path.join(SRC_DIR, 'background.ts'),
      popup: path.join(SRC_DIR, 'popup.tsx'),
      consent: path.join(SRC_DIR, 'consent-page.tsx'),
      'theme-boot': path.join(SRC_DIR, 'theme-boot.ts'),
    },
    bundle: true,
    outdir: outDir,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    jsx: 'automatic',
    // The fonts keep their names: the pages preload them.
    loader: { '.woff2': 'file' },
    assetNames: '[name]',
    legalComments: 'inline',
    logLevel: 'info',
    define: {
      __SERVER_URL__: JSON.stringify(serverUrl),
      __CONSOLE_ORIGIN__: JSON.stringify(consoleOrigin),
      'process.env.NODE_ENV': '"production"',
    },
  });

  const manifest = JSON.parse(await fs.readFile(path.join(SRC_DIR, 'manifest.json'), 'utf8'));

  manifest.externally_connectable = { matches: [`${consoleOrigin}/*`] };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const page of PAGES) {
    await fs.copyFile(path.join(SRC_DIR, page), path.join(outDir, page));
  }

  await fs.cp(path.join(SRC_DIR, 'icons'), path.join(outDir, 'icons'), { recursive: true });

  // The license of the Playwright modules travels with the bundle.
  await fs.copyFile(path.join(SRC_DIR, 'playwright', 'LICENSE'), path.join(outDir, 'LICENSE-playwright.txt'));
  await fs.copyFile(path.join(SRC_DIR, 'playwright', 'NOTICE'), path.join(outDir, 'NOTICE-playwright.txt'));

  // So do the licenses of the fonts the pages are set in.
  for (const license of ['LICENSE-Inter.txt', 'LICENSE-JetBrainsMono.txt']) {
    await fs.copyFile(path.join(FONTS_DIR, license), path.join(outDir, license));
  }

  await fs.writeFile(`${outDir}.zip`, zipSync(await filesOf(outDir, ARCHIVE_ROOT), { level: 9 }));

  return { version: manifest.version, dir: outDir, archive: `${outDir}.zip` };
}

// The extension of this installation; null when no console domain is named.
export async function buildInstallationExtension() {
  const domain = await readConsoleDomain();

  if (!domain) {
    return null;
  }

  const built = await buildBrowserExtension({ consoleOrigin: `https://${domain}`, serverUrl: `wss://${domain}` });

  console.log(`[browser-extension] ${built.version} for ${domain}: ${path.relative('.', built.dir)}, ${path.relative('.', built.archive)}`);

  return built;
}
