// The apps execution domain (balabash.app): the host-aware branch of the
// core. This middleware owns the WHOLE apps host — when the request's host
// is config.appsDomain nothing falls through to the main-domain surfaces
// (/api, /files, sessions): the minimal surface of the apps domain is part
// of the design (domains-and-auth.md).
//
// Current scope (steps 1–3): owner-mode serving behind the apps cookie
// (minted from the one-time token handoff at /auth — src/apps/auth.ts),
// vendor bundles, shell + module transformation, and the owner data gateway
// (/platform/api/apps/…), the public slugs and their gateway, and the SPA
// fallback: a navigation request to a path INSIDE an app folder that is
// neither the app root nor a file answers the app's shell, so an app may
// route by pathname (/apps/<path>/some/page, /<slug>/some/page) and survive
// a reload — the in-page router owns the rest of the path.

import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import type { Context, Next } from 'koa';
import { config } from '../config/index.ts';
import { prisma } from '../db/client.ts';
import { WorkspacePathError, guessContentType, sanitizeRelPath } from '../workspace/files.ts';
import { workspaceFilesDir } from '../workspace/layout.ts';
import { APP_MANIFEST_FILENAME, readAppManifest, type ManifestResult } from './manifest.ts';
import { callAppEndpoint } from './endpoints.ts';
import {
  APPS_COOKIE_MAX_AGE_MS,
  APPS_COOKIE_NAME,
  consumeHandoffToken,
  createAppsCookieValue,
  sanitizeAppsRedirect,
  verifyAppsCookieValue,
} from './auth.ts';
import { allowPublicHit } from './rate-limit.ts';
import { isTransformableModule, transformAppModule } from './transform.ts';
import { encodeJsonResponse } from './wire.ts';
import { VENDOR_INTERNAL_FILES, VENDOR_MODULES, renderAppShell, renderCatalogPage, renderManifestErrorPage } from './shell.ts';
import { listApps } from './management.ts';

const VENDOR_DIR = path.resolve('dist', 'apps-vendor');
const VENDOR_FILES = new Set([...Object.values(VENDOR_MODULES), ...VENDOR_INTERNAL_FILES]);

// Cache-busting version of the vendor URLs: the newest mtime of the bundles,
// computed once per process (the bundles only change with a build, a build
// only goes live with a restart).
let vendorVersionPromise: Promise<string> | null = null;

async function getVendorVersion(): Promise<string> {
  vendorVersionPromise ??= (async () => {
    let newest = 0;

    for (const file of VENDOR_FILES) {
      const stats = await fs.stat(path.join(VENDOR_DIR, file)).catch(() => null);

      newest = Math.max(newest, stats?.mtimeMs ?? 0);
    }

    return Math.round(newest).toString(36);
  })();

  return vendorVersionPromise;
}

function sendText(ctx: Context, status: number, message: string): void {
  ctx.status = status;
  ctx.type = 'text/plain; charset=utf-8';
  ctx.body = message;
}

// The JSON wire of the data gateway, exactly as the SDK expects it
// (sdk/data.ts): {result} on success, {error: {code, message}} otherwise.
function sendJsonError(ctx: Context, status: number, code: string, message: string): void {
  ctx.status = status;
  ctx.body = { error: { code, message } };
}

// The success wire of the data gateway: {result}, gzipped when large and
// accepted (wire.ts) — a bulk endpoint's megabytes travel compressed.
function sendJsonResult(ctx: Context, result: unknown): void {
  const encoded = encodeJsonResponse(JSON.stringify({ result }), ctx.get('accept-encoding'));

  ctx.status = 200;
  ctx.type = 'application/json';
  ctx.vary('accept-encoding');

  if (encoded.encoding) {
    ctx.set('content-encoding', encoded.encoding);
  }

  ctx.body = encoded.body;
}

// The bulk fence refused the call (endpoints.ts): a 503 with a short
// Retry-After — the SDK surfaces the message, a retrying UI waits a moment.
function sendBusy(ctx: Context, message: string): void {
  ctx.set('retry-after', '2');
  sendJsonError(ctx, 503, 'busy', message);
}

// Tolerant body read (the SDK always sends a JSON object): anything that is
// not a JSON object reads as {} — the param validation answers for the rest.
async function readJsonBody(ctx: Context): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of ctx.req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty body.
  }

  return {};
}

// Percent-decoding of the URL path, segment by segment (the same shape as
// the /files route): a broken escape is an honest 400, not a silent
// pass-through.
function decodePath(rawPath: string): string | null {
  try {
    return rawPath.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

// A navigation request (the browser asking for a page) as opposed to a
// resource fetch (a module script sends Accept: */*, a stylesheet text/css,
// an image image/*). Only navigations get the SPA fallback: a mistyped
// import must keep answering 404, never an HTML page disguised as a module.
function wantsHtml(ctx: Context): boolean {
  return ctx.get('accept').includes('text/html');
}

/** The nearest ancestor folder (deepest first) carrying an app manifest. */
async function findAppRoot(filesDir: string, relFilePath: string): Promise<string | null> {
  const segments = relFilePath.split('/');

  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/');
    const stats = await fs.stat(path.join(filesDir, candidate, APP_MANIFEST_FILENAME)).catch(() => null);

    if (stats?.isFile()) {
      return candidate;
    }
  }

  return null;
}

async function serveVendor(ctx: Context, filename: string): Promise<void> {
  if (!VENDOR_FILES.has(filename)) {
    sendText(ctx, 404, 'No such vendor bundle');

    return;
  }

  const absPath = path.join(VENDOR_DIR, filename);
  const stats = await fs.stat(absPath).catch(() => null);

  if (!stats?.isFile()) {
    sendText(ctx, 404, 'The vendor bundle is not built');

    return;
  }

  ctx.type = 'text/javascript; charset=utf-8';
  ctx.set('cache-control', 'public, max-age=31536000, immutable');
  ctx.length = stats.size;
  ctx.body = createReadStream(absPath);
}

// One app file: a transformable module goes through esbuild, everything else
// streams as-is. no-store everywhere — "update = overwrite" must be an F5.
async function serveAppFile(ctx: Context, filesDir: string, relFilePath: string, stats: Stats): Promise<void> {
  const absPath = path.join(filesDir, relFilePath);

  ctx.set('cache-control', 'no-store');

  if (isTransformableModule(relFilePath)) {
    ctx.type = 'text/javascript; charset=utf-8';
    ctx.body = await transformAppModule(absPath, stats);

    return;
  }

  const mediaType = relFilePath.endsWith('.css') ? 'text/css' : guessContentType(relFilePath);

  ctx.type = mediaType.startsWith('text/') ? `${mediaType}; charset=utf-8` : mediaType;
  ctx.length = stats.size;
  ctx.body = createReadStream(absPath);
}

// The owner shell of one app folder (manifest already read): a broken
// manifest renders as a readable error page, never a 500.
async function renderOwnerShell(ctx: Context, appPath: string, result: Exclude<ManifestResult, { status: 'absent' }>): Promise<void> {
  ctx.type = 'text/html; charset=utf-8';
  ctx.set('cache-control', 'no-store');

  if (result.status === 'invalid') {
    ctx.body = renderManifestErrorPage(appPath, result.error);

    return;
  }

  ctx.body = renderAppShell({
    manifest: result.manifest,
    vendorBase: '/platform/vendor',
    vendorVersion: await getVendorVersion(),
    context: {
      mode: 'owner',
      appBase: `/apps/${appPath}`,
      apiBase: `/platform/api/apps/${appPath}`,
      appPath,
      refreshUrl: `https://${config.domain}/apps/${appPath}`,
    },
  });
}

// The owner surface: /apps/<workspace-path>. The app root answers the shell;
// a file inside an app folder answers the file; any other path inside an app
// folder answers the shell too when the browser is navigating (the SPA
// fallback) and 404 otherwise.
async function serveOwnerPath(ctx: Context, userId: string, rawRest: string): Promise<void> {
  const decoded = decodePath(rawRest);

  if (decoded === null) {
    sendText(ctx, 400, 'Malformed percent-encoding in the path');

    return;
  }

  const trimmed = decoded.replace(/\/+$/, '');

  if (!trimmed) {
    // The owner's catalog: every app folder of the workspace, with run and
    // public links. Rendered fresh on every request — the filesystem is the
    // registry of existence.
    ctx.type = 'text/html; charset=utf-8';
    ctx.set('cache-control', 'no-store');
    ctx.body = renderCatalogPage(await listApps(userId), config.appsDomain ?? ctx.hostname);

    return;
  }

  let relPath: string;

  try {
    relPath = sanitizeRelPath(trimmed);
  } catch (error) {
    sendText(ctx, 400, error instanceof WorkspacePathError ? error.message : 'Invalid path');

    return;
  }

  const filesDir = workspaceFilesDir(userId);
  const stats = await fs.stat(path.join(filesDir, relPath)).catch(() => null);

  if (stats?.isDirectory()) {
    const result = await readAppManifest(userId, relPath);

    if (result.status !== 'absent') {
      await renderOwnerShell(ctx, relPath, result);

      return;
    }

    // A plain folder: inside an app it is a route like any other path
    // (the fallback below), outside an app it is nothing.
  }

  if (stats?.isFile()) {
    // A file is only served as part of an app: its nearest ancestor app
    // folder is the authorization to exist on this domain at all.
    const appRoot = await findAppRoot(filesDir, relPath);

    if (!appRoot) {
      sendText(ctx, 404, 'Not found');

      return;
    }

    await serveAppFile(ctx, filesDir, relPath, stats);

    return;
  }

  // Neither an app root nor a file: the SPA fallback. A navigation inside an
  // app folder answers the shell of the nearest ancestor app — the
  // in-page router reads the rest of the path. Resource fetches keep the
  // honest 404.
  const appRoot = wantsHtml(ctx) ? await findAppRoot(filesDir, relPath) : null;
  const result = appRoot ? await readAppManifest(userId, appRoot) : null;

  if (!appRoot || !result || result.status === 'absent') {
    sendText(ctx, 404, stats?.isDirectory() ? 'This folder is not an app (no balabash-app.json)' : 'Not found');

    return;
  }

  await renderOwnerShell(ctx, appRoot, result);
}

// The owner data gateway: POST /platform/api/apps/<app path>/<endpoint>.
// Endpoint calls answer JSON on every path — the SDK's error handling reads
// {error:{code,message}}, never an HTML page. This is the owner edge, so
// execution errors keep their messages; the public edge of step 4 must not.
async function serveOwnerEndpoint(ctx: Context, userId: string, rawRest: string): Promise<void> {
  const decoded = decodePath(rawRest);

  if (decoded === null) {
    sendJsonError(ctx, 400, 'bad_path', 'Malformed percent-encoding in the path');

    return;
  }

  const segments = decoded.replace(/\/+$/, '').split('/');

  if (segments.length < 2) {
    sendJsonError(ctx, 404, 'not_found', 'Expected /platform/api/apps/<app path>/<endpoint>');

    return;
  }

  const endpointName = segments[segments.length - 1] ?? '';

  let appPath: string;

  try {
    appPath = sanitizeRelPath(segments.slice(0, -1).join('/'));
  } catch (error) {
    sendJsonError(ctx, 400, 'bad_path', error instanceof WorkspacePathError ? error.message : 'Invalid path');

    return;
  }

  const manifest = await readAppManifest(userId, appPath);

  if (manifest.status === 'absent') {
    sendJsonError(ctx, 404, 'not_found', 'This folder is not an app (no balabash-app.json)');

    return;
  }

  if (manifest.status === 'invalid') {
    sendJsonError(ctx, 400, 'manifest_error', manifest.error);

    return;
  }

  // The api section is the app's whole runtime perimeter: an undeclared
  // endpoint does not exist, no matter what SQL anyone hoped to run.
  const endpoint = manifest.manifest.api[endpointName];

  if (!endpoint) {
    sendJsonError(ctx, 404, 'unknown_endpoint', `The app declares no endpoint "${endpointName}"`);

    return;
  }

  const body = await readJsonBody(ctx);
  const params = body.params;

  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    sendJsonError(ctx, 400, 'bad_params', 'The request body must be {"params": {…}}');

    return;
  }

  const outcome = await callAppEndpoint(userId, endpoint, (params as Record<string, unknown> | undefined) ?? {});

  switch (outcome.status) {
    case 'ok':
      sendJsonResult(ctx, outcome.result);

      return;
    case 'bad_params':
      sendJsonError(ctx, 400, 'bad_params', outcome.message);

      return;
    case 'busy':
      sendBusy(ctx, outcome.message);

      return;
    case 'error':
      sendJsonError(ctx, 500, 'endpoint_failed', outcome.message);
  }
}

// --------------------------------------------------------------------------
// The public surface: /:slug pages and assets, /platform/api/app/:slug/…
// gateway. The trust boundary of the anonymous visitor (design, границы
// доверия): rate-limited by IP, no error details ever leave, noindex.

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A publication row is only half the truth — the folder is existence
// itself: row without folder (or with a broken manifest) answers as absent
// or unavailable, never with details.
async function findPublication(slug: string): Promise<{ userId: string; path: string } | null> {
  if (!SLUG_PATTERN.test(slug)) {
    return null;
  }

  const row = await prisma.appPublication.findUnique({ where: { slug } });

  return row ? { userId: row.userId, path: row.path } : null;
}

// The public page/asset surface: /:slug is the shell, /:slug/<file> an asset
// of the app folder, /:slug/<anything else> the shell again for a navigation
// (the SPA fallback). The manifest itself is deliberately NOT served here —
// the api declaration is readable to the owner, not to the internet.
async function servePublicPath(ctx: Context, rawPath: string): Promise<void> {
  ctx.set('x-robots-tag', 'noindex');

  if (!allowPublicHit(ctx.ip)) {
    sendText(ctx, 429, 'Too many requests');

    return;
  }

  const decoded = decodePath(rawPath.replace(/^\/+/, '').replace(/\/+$/, ''));

  if (decoded === null) {
    sendText(ctx, 400, 'Malformed percent-encoding in the path');

    return;
  }

  const [slug = '', ...restSegments] = decoded.split('/');
  const publication = await findPublication(slug);

  if (!publication) {
    sendText(ctx, 404, 'Not found');

    return;
  }

  const manifest = await readAppManifest(publication.userId, publication.path);

  if (manifest.status === 'absent') {
    // The folder is gone (or is no longer an app): the filesystem is the
    // registry of existence, the stale row answers 404.
    sendText(ctx, 404, 'Not found');

    return;
  }

  if (manifest.status === 'invalid') {
    sendText(ctx, 503, 'This app is temporarily unavailable');

    return;
  }

  const appBase = `/${slug}`;

  const renderPublicShell = async (): Promise<void> => {
    ctx.type = 'text/html; charset=utf-8';
    ctx.set('cache-control', 'no-store');
    ctx.body = renderAppShell({
      manifest: manifest.manifest,
      vendorBase: '/platform/vendor',
      vendorVersion: await getVendorVersion(),
      context: {
        mode: 'public',
        appBase,
        apiBase: `/platform/api/app/${slug}`,
        slug,
      },
    });
  };

  if (restSegments.length === 0) {
    await renderPublicShell();

    return;
  }

  if (restSegments[restSegments.length - 1] === APP_MANIFEST_FILENAME) {
    sendText(ctx, 404, 'Not found');

    return;
  }

  let relFilePath: string;

  try {
    relFilePath = sanitizeRelPath(`${publication.path}/${restSegments.join('/')}`);
  } catch {
    sendText(ctx, 400, 'Invalid path');

    return;
  }

  const filesDir = workspaceFilesDir(publication.userId);
  const stats = await fs.stat(path.join(filesDir, relFilePath)).catch(() => null);

  if (stats?.isFile()) {
    await serveAppFile(ctx, filesDir, relFilePath, stats);

    return;
  }

  // Not a file: the SPA fallback for navigations, 404 for resource fetches
  // (the same rule as the owner surface).
  if (!wantsHtml(ctx)) {
    sendText(ctx, 404, 'Not found');

    return;
  }

  await renderPublicShell();
}

// The public data gateway: POST /platform/api/app/:slug/:endpoint. The same
// wire as the owner gateway with one deliberate difference — execution
// errors keep NO details: the internet learns that the endpoint failed,
// never why. Param validation messages stay: they describe the caller's
// input against the declared schema, not the owner's internals.
async function servePublicEndpoint(ctx: Context, rawRest: string): Promise<void> {
  if (!allowPublicHit(ctx.ip)) {
    sendJsonError(ctx, 429, 'rate_limited', 'Too many requests');

    return;
  }

  const decoded = decodePath(rawRest);

  if (decoded === null) {
    sendJsonError(ctx, 400, 'bad_path', 'Malformed percent-encoding in the path');

    return;
  }

  const segments = decoded.replace(/\/+$/, '').split('/');

  if (segments.length !== 2) {
    sendJsonError(ctx, 404, 'not_found', 'Expected /platform/api/app/<slug>/<endpoint>');

    return;
  }

  const [slug = '', endpointName = ''] = segments;
  const publication = await findPublication(slug);

  if (!publication) {
    sendJsonError(ctx, 404, 'not_found', 'Not found');

    return;
  }

  const manifest = await readAppManifest(publication.userId, publication.path);

  if (manifest.status === 'absent') {
    sendJsonError(ctx, 404, 'not_found', 'Not found');

    return;
  }

  if (manifest.status === 'invalid') {
    sendJsonError(ctx, 503, 'app_unavailable', 'This app is temporarily unavailable');

    return;
  }

  const endpoint = manifest.manifest.api[endpointName];

  if (!endpoint) {
    sendJsonError(ctx, 404, 'unknown_endpoint', `The app declares no endpoint "${endpointName}"`);

    return;
  }

  const body = await readJsonBody(ctx);
  const params = body.params;

  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    sendJsonError(ctx, 400, 'bad_params', 'The request body must be {"params": {…}}');

    return;
  }

  const outcome = await callAppEndpoint(publication.userId, endpoint, (params as Record<string, unknown> | undefined) ?? {});

  switch (outcome.status) {
    case 'ok':
      sendJsonResult(ctx, outcome.result);

      return;
    case 'bad_params':
      sendJsonError(ctx, 400, 'bad_params', outcome.message);

      return;
    case 'busy':
      sendBusy(ctx, outcome.message);

      return;
    case 'error':
      // The public edge: no details, deliberately.
      sendJsonError(ctx, 500, 'endpoint_failed', 'The endpoint failed');
  }
}

// The owner identity of the request: the apps cookie, verified statelessly.
// An invalid cookie answers null — how that reads (a redirect for pages, a
// 401 for the gateway) is the caller's business.
function resolveOwner(ctx: Context): string | null {
  return verifyAppsCookieValue(ctx.cookies.get(APPS_COOKIE_NAME));
}

// The apps-domain side of the handoff: /auth?token&redirect exchanges the
// one-time token for the apps cookie. A failed exchange is an honest 401
// with a link back to the main domain — NOT a redirect, so a systematically
// failing exchange cannot spin the refresh loop forever.
function handleAuthExchange(ctx: Context): void {
  const token = typeof ctx.query.token === 'string' ? ctx.query.token : '';
  const redirect = sanitizeAppsRedirect(ctx.query.redirect);

  // The token rides in the query string: never let it leak via Referer, and
  // never let this URL land in a cache or a search index.
  ctx.set('referrer-policy', 'no-referrer');
  ctx.set('cache-control', 'no-store');
  ctx.set('x-robots-tag', 'noindex');

  const userId = token ? consumeHandoffToken(token) : null;

  if (!userId) {
    ctx.status = 401;
    ctx.type = 'html';
    ctx.body = [
      '<!doctype html><meta charset="utf-8"><title>Link expired</title>',
      '<p>This sign-in link has expired or was already used.</p>',
      `<p><a href="https://${config.domain}${redirect}">Open it again</a> to get a fresh one.</p>`,
    ].join('\n');

    return;
  }

  ctx.cookies.set(APPS_COOKIE_NAME, createAppsCookieValue(userId), {
    maxAge: APPS_COOKIE_MAX_AGE_MS,
    sameSite: 'lax',
    httpOnly: true,
    secure: true,
    path: '/',
  });

  ctx.redirect(redirect);
}

async function handleApiRequest(ctx: Context): Promise<void> {
  if (ctx.method !== 'POST') {
    sendJsonError(ctx, 405, 'method_not_allowed', 'Endpoint calls are POST');

    return;
  }

  const { path: urlPath } = ctx;

  if (urlPath.startsWith('/platform/api/apps/')) {
    // The owner gateway answers 401 on a missing/expired cookie — the exact
    // signal the SDK's refresh loop listens for (sdk/data.ts): it sends the
    // browser to refreshUrl, the main domain re-mints, the app reloads.
    const userId = resolveOwner(ctx);

    if (!userId) {
      sendJsonError(ctx, 401, 'unauthorized', 'The apps cookie is missing or expired');

      return;
    }

    await serveOwnerEndpoint(ctx, userId, urlPath.slice('/platform/api/apps/'.length));

    return;
  }

  if (urlPath.startsWith('/platform/api/app/')) {
    await servePublicEndpoint(ctx, urlPath.slice('/platform/api/app/'.length));

    return;
  }

  sendJsonError(ctx, 404, 'not_found', 'Not found');
}

async function handleAppsRequest(ctx: Context): Promise<void> {
  const { path: urlPath } = ctx;

  if (urlPath.startsWith('/platform/api/')) {
    await handleApiRequest(ctx);

    return;
  }

  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    sendText(ctx, 405, 'Method not allowed');

    return;
  }

  if (urlPath.startsWith('/platform/vendor/')) {
    await serveVendor(ctx, urlPath.slice('/platform/vendor/'.length));

    return;
  }

  if (urlPath === '/auth') {
    handleAuthExchange(ctx);

    return;
  }

  if (urlPath === '/apps' || urlPath.startsWith('/apps/')) {
    // Owner surface behind the apps cookie. An invalid cookie on a page
    // navigation bounces the SAME path to the main domain — the self-refresh
    // loop: the main domain re-mints a token and sends the browser back.
    const userId = resolveOwner(ctx);

    if (!userId) {
      ctx.status = 302;
      ctx.redirect(`https://${config.domain}${urlPath}${ctx.search}`);

      return;
    }

    await serveOwnerPath(ctx, userId, urlPath === '/apps' ? '' : urlPath.slice('/apps/'.length));

    return;
  }

  // Everything else is the public surface: /:slug and /:slug/*. The
  // reserved slugs of the design (apps, auth, platform) are exactly the
  // branches above — a published slug can never shadow them by construction.
  await servePublicPath(ctx, urlPath);
}

/**
 * The host-aware branch: when the request addresses the apps domain, this
 * middleware IS the whole server — it never calls next(), so none of the
 * main-domain surfaces exist on balabash.app.
 */
export function createAppsMiddleware(): (ctx: Context, next: Next) => Promise<void> {
  return async (ctx, next) => {
    const appsDomain = config.appsDomain;

    if (!appsDomain || ctx.hostname.toLowerCase() !== appsDomain) {
      await next();

      return;
    }

    try {
      await handleAppsRequest(ctx);
    } catch (error) {
      console.error('[apps] unhandled error:', error);
      sendText(ctx, 500, 'Internal error');
    }
  };
}
