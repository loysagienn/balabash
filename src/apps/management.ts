// Publication management (step 4 of the /apps plan): the session-gated
// surface of the main domain. Existence of an app is ONLY the folder in the
// workspace file area (design №9) — these functions flip the publication
// fact in postgres and enumerate apps by scanning for manifests. Nothing
// here ever writes the file area.

import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from '../db/client.ts';
import { WorkspacePathError, sanitizeRelPath } from '../workspace/files.ts';
import { workspaceFilesDir } from '../workspace/layout.ts';
import { APP_MANIFEST_FILENAME, readAppManifest } from './manifest.ts';

// The user-facing message of a rejected management call (a 400, not a 500).
export class AppManagementError extends Error {}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// The path branches of the apps domain router: a published slug must never
// shadow them (design №8). The router matches these branches first anyway —
// this list keeps the invariant visible at publish time too.
const RESERVED_SLUGS = new Set(['apps', 'auth', 'platform']);

// Scan caps in the walkFiles spirit (indexer.ts): a runaway tree must not
// hang the management API. An app folder itself is a leaf — no app-in-app.
const MAX_SCANNED_DIRS = 2000;

export type AppListing = {
  /** Workspace-relative path of the app folder. */
  path: string;
  /** Manifest identity, or null when the manifest does not parse. */
  name: string | null;
  description: string | null;
  /** The manifest problem, when there is one. */
  manifestError: string | null;
  /** Published slug, or null. */
  slug: string | null;
};

function isSkippedName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

async function collectAppDirs(absDir: string, relPrefix: string, out: string[], budget: { dirs: number }): Promise<void> {
  if (budget.dirs <= 0) {
    return;
  }

  budget.dirs -= 1;

  let entries;

  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return; // vanished mid-walk — the filesystem is the source of truth
  }

  const isApp = entries.some(entry => entry.isFile() && entry.name === APP_MANIFEST_FILENAME);

  if (relPrefix && isApp) {
    out.push(relPrefix);

    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isSkippedName(entry.name)) {
      continue;
    }

    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    await collectAppDirs(path.join(absDir, entry.name), relPath, out, budget);
  }
}

/** Every app folder of the user's file area, joined with publication facts. */
export async function listApps(userId: string): Promise<AppListing[]> {
  const appDirs: string[] = [];

  await collectAppDirs(workspaceFilesDir(userId), '', appDirs, { dirs: MAX_SCANNED_DIRS });

  const publications = await prisma.appPublication.findMany({ where: { userId } });
  const slugByPath = new Map(publications.map(row => [row.path, row.slug]));

  const listings: AppListing[] = [];

  for (const appPath of appDirs.sort()) {
    const manifest = await readAppManifest(userId, appPath);

    if (manifest.status === 'absent') {
      continue; // vanished between the walk and the read
    }

    listings.push({
      path: appPath,
      name: manifest.status === 'ok' ? manifest.manifest.name : null,
      description: manifest.status === 'ok' ? manifest.manifest.description : null,
      manifestError: manifest.status === 'invalid' ? manifest.error : null,
      slug: slugByPath.get(appPath) ?? null,
    });
  }

  return listings;
}

function sanitizeAppPath(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new AppManagementError('path is required');
  }

  try {
    return sanitizeRelPath(rawPath.trim());
  } catch (error) {
    throw new AppManagementError(error instanceof WorkspacePathError ? error.message : 'Invalid path');
  }
}

/**
 * Publishes the app folder under the slug. The folder must be a valid app
 * right now — publishing a broken manifest is refused with the reason (this
 * is the owner edge; the public edge never shows it).
 */
export async function publishApp(userId: string, rawPath: unknown, rawSlug: unknown): Promise<{ slug: string; path: string }> {
  const appPath = sanitizeAppPath(rawPath);

  const slug = typeof rawSlug === 'string' ? rawSlug.trim().toLowerCase() : '';

  if (!SLUG_PATTERN.test(slug)) {
    throw new AppManagementError('slug must be 1–64 chars of [a-z0-9-], not starting or ending with "-"');
  }

  if (RESERVED_SLUGS.has(slug)) {
    throw new AppManagementError(`"${slug}" is a reserved name — pick another slug`);
  }

  const manifest = await readAppManifest(userId, appPath);

  if (manifest.status === 'absent') {
    throw new AppManagementError(`${appPath} is not an app: no ${APP_MANIFEST_FILENAME} there`);
  }

  if (manifest.status === 'invalid') {
    throw new AppManagementError(`The app's manifest is broken — fix it before publishing: ${manifest.error}`);
  }

  const existingByPath = await prisma.appPublication.findUnique({ where: { userId_path: { userId, path: appPath } } });

  if (existingByPath) {
    throw new AppManagementError(
      existingByPath.slug === slug
        ? `Already published as "${existingByPath.slug}"`
        : `Already published as "${existingByPath.slug}" — unpublish first to change the slug`,
    );
  }

  try {
    const row = await prisma.appPublication.create({ data: { userId, path: appPath, slug } });

    return { slug: row.slug, path: row.path };
  } catch (error) {
    // The slug unique constraint: taken by any user (including a racing
    // publish). The message deliberately does not say by whom.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      throw new AppManagementError(`The slug "${slug}" is taken — pick another one`);
    }

    throw error;
  }
}

/** Unpublishes by path or by slug (whichever is given); ownership-scoped. */
export async function unpublishApp(userId: string, rawPath: unknown, rawSlug: unknown): Promise<{ slug: string; path: string }> {
  if (typeof rawSlug === 'string' && rawSlug.trim()) {
    const slug = rawSlug.trim().toLowerCase();
    const row = await prisma.appPublication.findUnique({ where: { slug } });

    if (!row || row.userId !== userId) {
      throw new AppManagementError(`Nothing is published as "${slug}"`);
    }

    await prisma.appPublication.delete({ where: { id: row.id } });

    return { slug: row.slug, path: row.path };
  }

  const appPath = sanitizeAppPath(rawPath);
  const row = await prisma.appPublication.findUnique({ where: { userId_path: { userId, path: appPath } } });

  if (!row) {
    throw new AppManagementError(`${appPath} is not published`);
  }

  await prisma.appPublication.delete({ where: { id: row.id } });

  return { slug: row.slug, path: row.path };
}
