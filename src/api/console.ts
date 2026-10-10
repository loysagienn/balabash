// The console host (CONSOLE_DOMAIN, e.g. console.balabash.app): the new web
// interface — a browser SPA built from src/console into dist/console
// (build/console.js) and served by the core itself. On this host only three
// kinds of requests exist:
//
// - /api/* and /files/*: fall through to the session-gated surfaces of the
//   main chain — the same API, the same host-only session cookie (set here
//   by POST /api/auth, read here by everything else);
// - /connect/*, /oauth/* and /apps/<path>: fall through as well — the
//   one-time links and the OAuth redirect of a connection (src/api/connect.ts,
//   authenticated by their nonce and state, no session) and the owner page of
//   an app, where the handoff turns this host's session into a one-time
//   token for the apps domain (src/apps/handoff.ts; without a session it
//   sends the browser to /login?next=…, the SPA's door). The bare /apps is
//   the SPA's Apps screen;
// - /assets/<name>: the content-addressed bundle files, immutable;
// - /static/<name>: the files of src/console/public under their own stable
//   names (dist/console/public) — the web app manifest and the icons that
//   make the console installable on a phone's home screen; a short cache;
// - anything else that is a GET/HEAD: the shell — one HTML page pointing at
//   the assets named by dist/console/manifest.json. The in-page router owns
//   the path, so a reload on /threads/42 answers the same shell.
//
// The manifest is read from disk on every shell request (cached by mtime):
// a new build is live with the next page load, no restart involved. The
// process never bundles or holds the frontend — the frontend is just files.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import type { Context, Next } from 'koa';
import { config } from '../config/index.ts';

// Where build/console.js publishes: dist/console relative to the cwd (the
// repo root, like dist/apps-vendor) — overridable for tests.
const DEFAULT_CONSOLE_DIR = path.resolve('dist', 'console');
const ASSETS_PREFIX = '/assets/';
const STATIC_PREFIX = '/static/';

// The manifest and the icons are addressed by name, so their cache is short:
// an edited icon reaches a phone within the hour (Chrome re-reads the
// manifest of an installed app on its own schedule anyway).
const STATIC_CACHE_CONTROL = 'public, max-age=3600';
// What the shell points at (src/console/public; made by scripts/console-icons.mjs
// from the approved service icon). The tab's favicon is its own cut: the
// mark cropped to its visible pixels and fitted into the square by its
// height — it runs from the top edge to the bottom one, centered across
// (Vladimir's 29000; the "b" is taller than wide, and a square canvas is the
// one shape Chromium does not stretch); the install icons of the manifest
// keep the mark's built-in padding.
const WEB_APP_MANIFEST = `${STATIC_PREFIX}manifest.webmanifest`;
const FAVICON_32 = `${STATIC_PREFIX}favicon-32.png`;
const FAVICON_192 = `${STATIC_PREFIX}favicon-192.png`;
const APPLE_TOUCH_ICON = `${STATIC_PREFIX}apple-touch-icon.png`;
// tokens.css --bg: the status bar of the installed app and the browser's chrome take it.
const THEME_COLOR = '#0c0d0f';

// Paths that belong to the shared surfaces of the main chain, not to the
// SPA: the whole prefix (the path itself and anything under it)…
const PASS_THROUGH_PREFIXES = ['/api', '/files', '/connect', '/oauth'];
// …or only what lies under it, the prefix itself (and its empty trailing
// slash) staying the SPA's: /apps is the Apps screen, /apps/<path> the
// owner page of an app.
const PASS_THROUGH_UNDER_PREFIXES = ['/apps'];

type ConsoleManifest = {
  builtAt: string;
  js: string;
  css: string | null;
  // Font asset names of the build (woff2); absent in older manifests.
  fonts?: string[];
};

// The faces worth a preload: what the first paint of any screen uses.
const PRELOAD_FONTS = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'JetBrainsMono-Regular'];

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isPassThrough(urlPath: string): boolean {
  return (
    PASS_THROUGH_PREFIXES.some(prefix => urlPath === prefix || urlPath.startsWith(`${prefix}/`)) ||
    PASS_THROUGH_UNDER_PREFIXES.some(prefix => urlPath.startsWith(`${prefix}/`) && urlPath.length > prefix.length + 1)
  );
}

// --------------------------------------------------------------------------
// Manifest: read on demand, re-read when the file's mtime changes.

type ConsoleDir = { assetsDir: string; publicDir: string; manifestPath: string };

function consoleDir(root: string): ConsoleDir {
  return { assetsDir: path.join(root, 'assets'), publicDir: path.join(root, 'public'), manifestPath: path.join(root, 'manifest.json') };
}

let cachedManifest: { path: string; mtimeMs: number; manifest: ConsoleManifest } | null = null;

function isManifest(value: unknown): value is ConsoleManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConsoleManifest).js === 'string' &&
    ((value as ConsoleManifest).css === null || typeof (value as ConsoleManifest).css === 'string')
  );
}

async function readManifest(manifestPath: string): Promise<ConsoleManifest | null> {
  const stats = await fs.stat(manifestPath).catch(() => null);

  if (!stats) {
    cachedManifest = null;

    return null;
  }

  if (cachedManifest && cachedManifest.path === manifestPath && cachedManifest.mtimeMs === stats.mtimeMs) {
    return cachedManifest.manifest;
  }

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    if (!isManifest(parsed)) {
      console.error('[console] manifest.json has an unexpected shape');

      return null;
    }

    cachedManifest = { path: manifestPath, mtimeMs: stats.mtimeMs, manifest: parsed };

    return parsed;
  } catch (error) {
    console.error('[console] failed to read manifest.json:', error);

    return null;
  }
}

// --------------------------------------------------------------------------
// The shell.

export function preloadedFonts(manifest: ConsoleManifest): string[] {
  return (manifest.fonts ?? []).filter(name => PRELOAD_FONTS.some(face => name.startsWith(`${face}-`)));
}

export function renderConsoleShell(manifest: ConsoleManifest): string {
  const cssLink = manifest.css ? `\n  <link rel="stylesheet" href="${escapeHtml(`${ASSETS_PREFIX}${manifest.css}`)}">` : '';
  const fontLinks = preloadedFonts(manifest)
    .map(name => `\n  <link rel="preload" as="font" type="font/woff2" crossorigin href="${escapeHtml(`${ASSETS_PREFIX}${name}`)}">`)
    .join('');

  // The viewport forbids the phone's pinch-to-zoom (Vladimir's rule) — a
  // viewport meta is a mobile browser's business, the desktop's zoom is
  // untouched; iOS Safari ignores user-scalable and is handled by CSS
  // touch-action and lib/touch instead. The manifest, the icons and the
  // apple-/mobile-web-app-* metas make the console installable on the home
  // screen: Android Chrome from its manifest (no service worker is required
  // since Chrome 108 for the install from the menu), iOS Safari from the
  // manifest's display plus apple-touch-icon for the icon.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="${THEME_COLOR}">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Balabash">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="console-build" content="${escapeHtml(manifest.builtAt)}">
  <title>Balabash</title>
  <link rel="manifest" href="${WEB_APP_MANIFEST}">
  <link rel="icon" type="image/png" sizes="32x32" href="${FAVICON_32}">
  <link rel="icon" type="image/png" sizes="192x192" href="${FAVICON_192}">
  <link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON}">${fontLinks}${cssLink}
  <script type="module" src="${escapeHtml(`${ASSETS_PREFIX}${manifest.js}`)}"></script>
</head>
<body>
  <div id="root"></div>
</body>
</html>
`;
}

function renderNotBuiltPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Balabash console</title>
  <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto 0;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
  <h1>Console is not built</h1>
  <p>No <code>dist/console/manifest.json</code> on the server. Run <code>npm run build-console</code>.</p>
</body>
</html>
`;
}

// --------------------------------------------------------------------------
// Files by name: the assets (one flat directory, names content-addressed,
// cached forever) and the public files (stable names, cached briefly).

async function serveFile(ctx: Context, dir: string, name: string, cacheControl: string): Promise<void> {
  // A single path segment, nothing that walks: the build names assets
  // [name]-[hash].ext and copies public files as they are; nothing else
  // lives in either directory.
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
    ctx.status = 404;
    ctx.body = 'Not found';

    return;
  }

  const file = path.join(dir, name);
  const stats = await fs.stat(file).catch(() => null);

  if (!stats || !stats.isFile()) {
    ctx.status = 404;
    ctx.body = 'Not found';

    return;
  }

  ctx.status = 200;
  ctx.type = ASSET_TYPES[path.extname(name)] ?? 'application/octet-stream';
  ctx.length = stats.size;
  ctx.set('cache-control', cacheControl);

  if (ctx.method === 'HEAD') {
    return;
  }

  ctx.body = createReadStream(file);
}

// --------------------------------------------------------------------------
// The middleware.

/**
 * The host-aware branch of the console: when the request addresses
 * CONSOLE_DOMAIN, the shared surfaces (/api, /files, /connect, /oauth and
 * the owner pages /apps/<path>) pass to the main chain and everything else
 * is the SPA. Other hosts are untouched.
 */
export function createConsoleMiddleware(root: string = DEFAULT_CONSOLE_DIR): (ctx: Context, next: Next) => Promise<void> {
  const { assetsDir, publicDir, manifestPath } = consoleDir(root);

  return async (ctx, next) => {
    const consoleDomain = config.consoleDomain;

    if (!consoleDomain || ctx.hostname.toLowerCase() !== consoleDomain) {
      await next();

      return;
    }

    if (isPassThrough(ctx.path)) {
      await next();

      return;
    }

    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      ctx.status = 405;
      ctx.set('allow', 'GET, HEAD');
      ctx.body = 'Method not allowed';

      return;
    }

    try {
      if (ctx.path.startsWith(ASSETS_PREFIX)) {
        await serveFile(ctx, assetsDir, ctx.path.slice(ASSETS_PREFIX.length), 'public, max-age=31536000, immutable');

        return;
      }

      if (ctx.path.startsWith(STATIC_PREFIX)) {
        await serveFile(ctx, publicDir, ctx.path.slice(STATIC_PREFIX.length), STATIC_CACHE_CONTROL);

        return;
      }

      const manifest = await readManifest(manifestPath);

      ctx.status = manifest ? 200 : 503;
      ctx.type = 'text/html; charset=utf-8';
      // The shell is the switch between builds: never cache it.
      ctx.set('cache-control', 'no-store');
      ctx.body = manifest ? renderConsoleShell(manifest) : renderNotBuiltPage();
    } catch (error) {
      console.error('[console] unhandled error:', error);
      ctx.status = 500;
      ctx.type = 'text/plain; charset=utf-8';
      ctx.body = 'Internal error';
    }
  };
}
