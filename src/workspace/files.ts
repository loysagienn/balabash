// The core of the workspace FILE AREA: the one place that owns the path
// boundary, the content-type table and the read-side primitives over
// data/workspace/<userId>/files. Both consumers go through here — the
// workbench tools (tools/workspace.ts) and the web API (/api/workspace/*) —
// so the boundary check exists exactly once. The currency is a relative path
// inside the file area; the userId comes from the caller's identity (MCP
// _meta / web session), never from model- or user-supplied parameters.
//
// Reads NEVER provision: no mkdir, and workspace.sqlite is only opened when
// it already exists (DatabaseSync creates the database on open — on a read
// path that would be a write). A missing database means empty metadata.
// Write-side provisioning (ensureWorkspace) stays with the tools.

import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { workspaceDbPath, workspaceFilesDir } from './layout.ts';

const MAX_REL_PATH_LENGTH = 300;

// A rejected path: the caller decides the edge shape (ToolError for the
// tools' wire, 400 for the web API). The message is the whole payload.
export class WorkspacePathError extends Error {
  override name = 'WorkspacePathError';
}

/**
 * Validates a caller-supplied path as relative-inside-the-file-area: no
 * absolute paths, no "..", normalized "/" separators.
 */
export function sanitizeRelPath(raw: string, label = 'path'): string {
  const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');

  if (!value) {
    throw new WorkspacePathError(`The ${label} must be a non-empty relative path.`);
  }

  if (value.length > MAX_REL_PATH_LENGTH) {
    throw new WorkspacePathError(`The ${label} is longer than ${MAX_REL_PATH_LENGTH} characters.`);
  }

  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new WorkspacePathError(`The ${label} must be relative to the workspace file area, not absolute: "${raw}".`);
  }

  const segments = value.split('/');

  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new WorkspacePathError(`The ${label} must not contain "..", "." or empty segments: "${raw}".`);
  }

  return segments.join('/');
}

/** Absolute path of a file-area entry after sanitization. No mkdir. */
export function resolveFilePath(userId: string, relPath: string): string {
  return path.join(workspaceFilesDir(userId), sanitizeRelPath(relPath));
}

// ---------------------------------------------------------------------------
// Content types by extension — shared by exports, the raw endpoint and the
// node metadata (mediaType drives the web viewers).
// ---------------------------------------------------------------------------

export const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function guessContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();

  return CONTENT_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// File metadata (title/description) in the _files table of workspace.sqlite.
// Filesystem is the source of truth for existence; _files only annotates.
// ---------------------------------------------------------------------------

export type FileMeta = { title: string | null; description: string | null };

// Short-lived in-process handle for the tiny metadata operations. Bulk SQL
// (data_query) runs in a child process instead — DatabaseSync is synchronous
// and must not block the single app process on a heavy query.
export function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

export function readMeta(db: DatabaseSync, relPath: string): FileMeta {
  const row = db.prepare('SELECT title, description FROM _files WHERE path = ?').get(relPath) as
    | { title: string | null; description: string | null }
    | undefined;

  return { title: row?.title ?? null, description: row?.description ?? null };
}

// The read-side door to the metadata: opens the database only when the file
// already exists (opening would create it), degrades to empty metadata.
async function withExistingDb<T>(userId: string, fallback: T, fn: (db: DatabaseSync) => T): Promise<T> {
  const dbPath = workspaceDbPath(userId);
  const stats = await fs.stat(dbPath).catch(() => null);

  if (!stats?.isFile()) {
    return fallback;
  }

  return withDb(dbPath, fn);
}

function readMetaMap(db: DatabaseSync): Map<string, FileMeta> {
  const map = new Map<string, FileMeta>();
  const rows = db.prepare('SELECT path, title, description FROM _files').all() as Array<{
    path: string;
    title: string | null;
    description: string | null;
  }>;

  for (const row of rows) {
    map.set(row.path, { title: row.title, description: row.description });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Read primitives: the node shape shared by listings and single-file stats.
// ---------------------------------------------------------------------------

// sizeBytes/modifiedAt are null only when the entry vanished between readdir
// and stat — the listing stays honest instead of failing.
export type WorkspaceFileNode = {
  path: string;
  sizeBytes: number | null;
  modifiedAt: string | null; // ISO date-time
  title: string | null;
  description: string | null;
  mediaType: string;
};

export type WorkspaceDirListing = {
  directories: string[];
  files: WorkspaceFileNode[];
};

/**
 * Lists one directory (non-recursive), '' = the file-area root. A missing
 * root reads as an empty area (nothing was provisioned yet); a missing (or
 * non-directory) subpath returns null — the edge decides the answer shape.
 */
export async function listDir(userId: string, relDir: string): Promise<WorkspaceDirListing | null> {
  const rel = relDir ? sanitizeRelPath(relDir, 'directory path') : '';
  const filesDir = workspaceFilesDir(userId);
  const absDir = rel ? path.join(filesDir, rel) : filesDir;

  let entries;

  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return rel ? null : { directories: [], files: [] };
  }

  const directories: string[] = [];
  const files: WorkspaceFileNode[] = [];
  const presentNames = new Set<string>();

  const metaByPath = await withExistingDb(userId, new Map<string, FileMeta>(), readMetaMap);

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      directories.push(entry.name);
      continue;
    }

    if (!entry.isFile()) continue;

    presentNames.add(entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const stats = await fs.stat(path.join(absDir, entry.name)).catch(() => null);
    const meta = metaByPath.get(relPath);

    files.push({
      path: relPath,
      sizeBytes: stats?.size ?? null,
      modifiedAt: stats?.mtime.toISOString() ?? null,
      title: meta?.title ?? null,
      description: meta?.description ?? null,
      mediaType: guessContentType(entry.name),
    });
  }

  // The filesystem is the source of truth: metadata rows whose files in
  // this directory are gone (deleted by a script) are pruned on sight.
  const stale = [...metaByPath.keys()].filter(metaPath => {
    const slash = metaPath.lastIndexOf('/');
    const parent = slash === -1 ? '' : metaPath.slice(0, slash);
    const name = slash === -1 ? metaPath : metaPath.slice(slash + 1);
    return parent === rel && !presentNames.has(name);
  });

  if (stale.length) {
    await withExistingDb(userId, undefined, db => {
      const remove = db.prepare('DELETE FROM _files WHERE path = ?');
      for (const metaPath of stale) remove.run(metaPath);
    });
  }

  return { directories, files };
}

/** The node of one file; null when the path is missing or not a file. */
export async function statFile(userId: string, relPath: string): Promise<WorkspaceFileNode | null> {
  const rel = sanitizeRelPath(relPath);
  const absPath = path.join(workspaceFilesDir(userId), rel);
  const stats = await fs.stat(absPath).catch(() => null);

  if (!stats?.isFile()) {
    return null;
  }

  const meta = await withExistingDb(userId, { title: null, description: null } as FileMeta, db => readMeta(db, rel));

  return {
    path: rel,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    title: meta.title,
    description: meta.description,
    mediaType: guessContentType(rel),
  };
}
