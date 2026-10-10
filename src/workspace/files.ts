// The core of the workspace FILE AREA: the one place that owns the path
// boundary, the content-type table and the primitives over
// data/workspace/<userId>/files. All consumers go through here — the
// workbench tool servers (tools/workspace.ts, tools/workspace_files.ts) and
// the web API (/api/workspace/*) — so the boundary check exists exactly once.
// The currency is a relative path inside the file area; the userId comes from
// the caller's identity (MCP _meta / web session), never from model- or
// user-supplied parameters.
//
// Reads NEVER provision: no mkdir, and workspace.sqlite is only opened when
// it already exists (DatabaseSync creates the database on open — on a read
// path that would be a write). A missing database means empty metadata.
// Write-side provisioning is explicit: ensureFilesDb here owns the _files
// DDL; directory provisioning (ensureWorkspace) stays with the tools.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { BigIntStats, Stats } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { workspaceDbPath, workspaceFilesDir } from './layout.ts';
import { WorkspaceDbBusyError, inWriteTransaction, withWorkspaceDb, type WithDbOptions } from './sqlite.ts';

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
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.log': 'text/plain',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.sql': 'application/sql',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.rb': 'text/x-ruby',
  '.php': 'text/x-php',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
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

// The tiny metadata operations run on short-lived in-process handles under
// the platform's lock policy (src/workspace/sqlite.ts: short synchronous
// busy slices, asynchronous retries — the event loop stays free while a
// foreign writer holds the database). Bulk SQL (data_query) runs in a child
// process instead — DatabaseSync is synchronous and must not block the
// single app process on a heavy query.

// Write-side provisioning of the metadata database: creates workspace.sqlite
// (DatabaseSync creates on open) with the _files table. The one owner of the
// _files DDL — the workbench tools and the annotation indexer both call this
// before their first write. WAL lets tool calls and script children
// read/write concurrently.
export async function ensureFilesDb(dbPath: string): Promise<void> {
  await withWorkspaceDb(dbPath, db => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS _files (' +
        'path TEXT PRIMARY KEY, title TEXT, description TEXT, updated_at TEXT NOT NULL)',
    );
  });
}

export function readMeta(db: DatabaseSync, relPath: string): FileMeta {
  const row = db.prepare('SELECT title, description FROM _files WHERE path = ?').get(relPath) as
    { title: string | null; description: string | null } | undefined;

  return { title: row?.title ?? null, description: row?.description ?? null };
}

// The write primitive of the metadata: annotating a file. A null keeps
// the existing value (COALESCE) — callers update title and description
// independently. The caller is responsible for the database existing (the
// tools' ensureWorkspace provisions it).
export function upsertMeta(
  dbPath: string,
  relPath: string,
  title: string | null,
  description: string | null,
): Promise<FileMeta> {
  return withWorkspaceDb(dbPath, db => {
    db.prepare(
      "INSERT INTO _files (path, title, description, updated_at) VALUES (?, ?, ?, datetime('now')) " +
        'ON CONFLICT(path) DO UPDATE SET ' +
        'title = COALESCE(excluded.title, _files.title), ' +
        'description = COALESCE(excluded.description, _files.description), ' +
        'updated_at = excluded.updated_at',
    ).run(relPath, title, description);

    return readMeta(db, relPath);
  });
}

// The read-side door to the metadata: opens the database only when the file
// already exists (opening would create it), degrades to empty metadata.
async function withExistingDb<T>(
  userId: string,
  fallback: T,
  fn: (db: DatabaseSync) => T,
  options?: WithDbOptions,
): Promise<T> {
  const dbPath = workspaceDbPath(userId);
  const stats = await fs.stat(dbPath).catch(() => null);

  if (!stats?.isFile()) {
    return fallback;
  }

  return withWorkspaceDb(dbPath, fn, options);
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

// The pruning primitive: drops the metadata rows of the given paths. Shared
// by the listing (orphans of one directory, on sight) and the indexer
// (orphans of the whole area, once a pass). A missing database has nothing
// to prune — a read-side door, never provisions.
export async function deleteMeta(userId: string, relPaths: string[], options?: WithDbOptions): Promise<void> {
  if (!relPaths.length) {
    return;
  }

  // One short IMMEDIATE transaction: the write lock is taken up front and
  // the rows go in a single step instead of one autocommit per path.
  await withExistingDb(
    userId,
    undefined,
    db =>
      inWriteTransaction(db, () => {
        const remove = db.prepare('DELETE FROM _files WHERE path = ?');

        for (const relPath of relPaths) {
          remove.run(relPath);
        }
      }),
    options,
  );
}

// The listing's on-sight pruning is hygiene, not the answer: it waits for a
// foreign writer only briefly, and a busy database leaves the rows to the
// indexer's next sweep rather than stalling (or failing) the listing.
const PRUNE_ON_SIGHT_LOCK_WAIT_MS = 2_000;

// Annotation freshness index for the background indexer: every _files row's
// updated_at as a UTC Date, keyed by path. Empty when the database does not
// exist yet (a read never provisions).
export async function readAnnotationTimes(userId: string): Promise<Map<string, Date>> {
  return withExistingDb(userId, new Map<string, Date>(), db => {
    const map = new Map<string, Date>();
    const rows = db.prepare('SELECT path, updated_at FROM _files').all() as Array<{
      path: string;
      updated_at: string;
    }>;

    for (const row of rows) {
      // sqlite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC.
      const parsed = new Date(`${row.updated_at.replace(' ', 'T')}Z`);

      if (!Number.isNaN(parsed.getTime())) {
        map.set(row.path, parsed);
      }
    }

    return map;
  });
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

// A folder of a listing: its own modification time — moved by a direct
// entry added, removed or renamed, not by the files inside changing (the
// file manager's reading of a folder's date) — and the count of its direct
// children by the listing's own rule (directories and regular files). The
// two facts come from two independent reads and each is null on its own:
// modifiedAt when the stat failed, both counts when the readdir failed — so
// a folder nobody may look into keeps its date with unknown counts, and a
// folder that vanished between the listing and its reads is all null.
export type WorkspaceFolderNode = {
  path: string;
  modifiedAt: string | null; // ISO date-time
  directoryCount: number | null;
  fileCount: number | null;
};

export type WorkspaceDirListing = {
  // The names, in order; folders carries the same entries with their facts.
  directories: string[];
  folders: WorkspaceFolderNode[];
  files: WorkspaceFileNode[];
};

// One stat and one readdir per folder — the counts come from the entry
// types, no stat of the children. Each read fails into its own nulls.
async function folderNode(absDir: string, relPath: string): Promise<WorkspaceFolderNode> {
  const [stats, entries] = await Promise.all([
    fs.stat(absDir).catch(() => null),
    fs.readdir(absDir, { withFileTypes: true }).catch(() => null),
  ]);

  return {
    path: relPath,
    modifiedAt: stats?.mtime.toISOString() ?? null,
    directoryCount: entries ? entries.filter(entry => entry.isDirectory()).length : null,
    fileCount: entries ? entries.filter(entry => entry.isFile()).length : null,
  };
}

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
    return rel ? null : { directories: [], folders: [], files: [] };
  }

  const directories: string[] = [];
  const folders: Promise<WorkspaceFolderNode>[] = [];
  const files: WorkspaceFileNode[] = [];
  const presentNames = new Set<string>();

  const metaByPath = await withExistingDb(userId, new Map<string, FileMeta>(), readMetaMap);

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      directories.push(entry.name);
      folders.push(folderNode(path.join(absDir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
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
  // this directory are gone (deleted by a script) are pruned on sight. Only
  // direct children are visible here — a deleted subdirectory's rows are
  // the indexer's area-wide sweep to catch.
  const stale = [...metaByPath.keys()].filter(metaPath => {
    const slash = metaPath.lastIndexOf('/');
    const parent = slash === -1 ? '' : metaPath.slice(0, slash);
    const name = slash === -1 ? metaPath : metaPath.slice(slash + 1);
    return parent === rel && !presentNames.has(name);
  });

  try {
    await deleteMeta(userId, stale, { lockWaitMs: PRUNE_ON_SIGHT_LOCK_WAIT_MS });
  } catch (error) {
    if (!(error instanceof WorkspaceDbBusyError)) {
      throw error;
    }
  }

  return { directories, folders: await Promise.all(folders), files };
}

// ---------------------------------------------------------------------------
// Write primitive: the whole content of one file replaced in a step.
// ---------------------------------------------------------------------------

// The file boundary of a write, beyond the string boundary of
// sanitizeRelPath: the entry itself is a regular file (lstat — a symbolic
// link is not a file of the area, the listing does not show one) and the
// folder it is in really lies inside the area (realpath of the parent under
// the realpath of the area — a link to a folder outside would otherwise
// carry the write there). The stats are the inode's in full precision, the
// ones a precondition compares against. What is not covered: a parent
// swapped for a link between this look and the rename — the other writers
// here are the operator's own agents, not an adversary.
export async function statWritable(userId: string, relPath: string): Promise<BigIntStats | null> {
  const absPath = resolveFilePath(userId, relPath);
  const [stats, areaReal, parentReal] = await Promise.all([
    fs.lstat(absPath, { bigint: true }).catch(() => null),
    fs.realpath(workspaceFilesDir(userId)).catch(() => null),
    fs.realpath(path.dirname(absPath)).catch(() => null),
  ]);

  if (!stats?.isFile() || areaReal === null || parentReal === null) {
    return null;
  }

  return parentReal === areaReal || parentReal.startsWith(areaReal + path.sep) ? stats : null;
}

// One write of a file at a time within this process: a conditional write
// (look, compare, replace, answer) runs whole before the next one looks, so
// two writes under one validator end as one success and one refusal, not
// two successes. Keyed by user and path; the chain is dropped once nobody
// is in it. Writers outside the process (agents on the host) are not held
// by this — their window is the one described at replaceFileContent.
const writeChains = new Map<string, Promise<unknown>>();

export async function withFileWriteLock<T>(userId: string, relPath: string, work: () => Promise<T>): Promise<T> {
  const key = `${userId}/${sanitizeRelPath(relPath)}`;
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  writeChains.set(key, settled);

  try {
    return await run;
  } finally {
    if (writeChains.get(key) === settled) {
      writeChains.delete(key);
    }
  }
}

// The bytes land in a sibling temp file and take the file's name by rename:
// a reader sees the old content or the new one, never a half-written file,
// and a failure leaves the file as it was (the temp file is removed; the
// one a crash leaves behind is a dot-file beside it, `.write-<hex>.tmp` —
// its own short name, so a file whose name is near the limit of a name can
// still be written). The answer is the stats of the written inode, taken
// through the open handle after the rename: the validator of these bytes
// and no other — a replacement of the file by another writer in the same
// instant (a rename of theirs) is a different inode and does not show here,
// so a tag built from them names what was saved, and the next conditional
// write under it is refused once the file is no longer those bytes. What
// may be replaced is the caller's rule (the web API: an existing Markdown
// file under a size limit, under a precondition); here — a path inside the
// area whose folder exists. Two readings of the one inode: the node's
// (milliseconds, as the listing's stat rounds them) and the validator's
// (nanoseconds, truncated) — a millisecond derived from the latter can
// differ from the listing's by one at the edge of a millisecond.
export type WrittenFile = { stats: Stats; validator: BigIntStats };

export async function replaceFileContent(userId: string, relPath: string, content: Buffer): Promise<WrittenFile> {
  const absPath = resolveFilePath(userId, relPath);
  const temp = path.join(path.dirname(absPath), `.write-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(temp, 'wx');

  try {
    await handle.writeFile(content);
    await fs.rename(temp, absPath);

    const [stats, validator] = await Promise.all([handle.stat(), handle.stat({ bigint: true })]);

    return { stats, validator };
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

// The node of a file from its stats (the listing's shape) and its
// annotation.
async function fileNode(userId: string, rel: string, stats: Pick<Stats, 'size' | 'mtime'>): Promise<WorkspaceFileNode> {
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

/** The node of a file the caller has the stats of (a write's answer). */
export function fileNodeOf(userId: string, relPath: string, stats: Pick<Stats, 'size' | 'mtime'>): Promise<WorkspaceFileNode> {
  return fileNode(userId, sanitizeRelPath(relPath), stats);
}

/** The node of one file; null when the path is missing or not a file. */
export async function statFile(userId: string, relPath: string): Promise<WorkspaceFileNode | null> {
  const rel = sanitizeRelPath(relPath);
  const stats = await fs.stat(path.join(workspaceFilesDir(userId), rel)).catch(() => null);

  return stats?.isFile() ? fileNode(userId, rel, stats) : null;
}
