// The console host (CONSOLE_DOMAIN, e.g. console.balabash.app): the new web
// interface — a browser SPA built from src/console into dist/console
// (build/console.js) and served by the core itself. On this host only three
// kinds of requests exist:
//
// - /api/* and /files/*: fall through to the session-gated surfaces of the
//   main chain — the same API, the same host-only session cookie (set here
//   by POST /api/auth, read here by everything else);
// - /assets/<name>: the content-addressed bundle files, immutable;
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

// Paths that belong to the shared surfaces, not to the SPA.
const PASS_THROUGH_PREFIXES = ['/api', '/files'];

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
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isPassThrough(urlPath: string): boolean {
  return PASS_THROUGH_PREFIXES.some(prefix => urlPath === prefix || urlPath.startsWith(`${prefix}/`));
}

// --------------------------------------------------------------------------
// Manifest: read on demand, re-read when the file's mtime changes.

type ConsoleDir = { assetsDir: string; manifestPath: string };

function consoleDir(root: string): ConsoleDir {
  return { assetsDir: path.join(root, 'assets'), manifestPath: path.join(root, 'manifest.json') };
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="console-build" content="${escapeHtml(manifest.builtAt)}">
  <title>Balabash</title>${fontLinks}${cssLink}
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
// Assets: one flat directory, names are content-addressed.

async function serveAsset(ctx: Context, assetsDir: string, name: string): Promise<void> {
  // A single path segment, nothing that walks: the build names files
  // [name]-[hash].ext, nothing else lives there.
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
    ctx.status = 404;
    ctx.body = 'Not found';

    return;
  }

  const file = path.join(assetsDir, name);
  const stats = await fs.stat(file).catch(() => null);

  if (!stats || !stats.isFile()) {
    ctx.status = 404;
    ctx.body = 'Not found';

    return;
  }

  ctx.status = 200;
  ctx.type = ASSET_TYPES[path.extname(name)] ?? 'application/octet-stream';
  ctx.length = stats.size;
  ctx.set('cache-control', 'public, max-age=31536000, immutable');

  if (ctx.method === 'HEAD') {
    return;
  }

  ctx.body = createReadStream(file);
}

// --------------------------------------------------------------------------
// The middleware.

/**
 * The host-aware branch of the console: when the request addresses
 * CONSOLE_DOMAIN, /api and /files pass to the main chain and everything else
 * is the SPA. Other hosts are untouched.
 */
export function createConsoleMiddleware(root: string = DEFAULT_CONSOLE_DIR): (ctx: Context, next: Next) => Promise<void> {
  const { assetsDir, manifestPath } = consoleDir(root);

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
        await serveAsset(ctx, assetsDir, ctx.path.slice(ASSETS_PREFIX.length));

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
