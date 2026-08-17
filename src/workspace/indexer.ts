// Background annotation indexer: system hygiene over every workspace's file
// area. Files created by native tools, shells or scripts get no
// title/description from their writers — this service walks the file areas on
// a timer, finds files whose annotation is missing or older than the file
// (mtime vs _files.updated_at), reads the head of each and asks a cheap
// model for a title and description, then upserts them into workspace.sqlite.
//
// Deliberately NOT a scheduled task and NOT tied to any thread: tasks are
// user-owned, workspace-bound infrastructure; this is the platform observing
// all workspaces. No persistent state of its own — idempotence comes from
// the mtime/updated_at comparison, so an empty pass costs only stats.
// A manual (or any newer) annotation wins: annotating bumps updated_at past
// mtime, and the file is not touched again until it changes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';
import { getOpenaiClient } from '../harness/openai/client.ts';
import { ensureFilesDb, readAnnotationTimes, upsertMeta } from './files.ts';
import { workspaceDbPath, workspaceFilesDir, workspaceRoot } from './layout.ts';

const FIRST_PASS_DELAY_MS = 2 * 60_000;
const PASS_INTERVAL_MS = 15 * 60_000;

// Cost ceilings per pass: at most this many model calls (the leftovers wait
// for the next pass) and at most this much of each file's content.
const MAX_MODEL_CALLS_PER_PASS = 20;
const HEAD_BYTES = 6_000;
const MODEL_TIMEOUT_MS = 60_000;

// Walk safety cap per user — a runaway file area must not own the pass.
const MAX_FILES_PER_USER = 5_000;

const SKIPPED_DIR_NAMES = new Set(['node_modules', '__pycache__']);

// Binary content is ignored entirely — no annotation, not even by filename.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.heic',
  '.mp3', '.ogg', '.wav', '.flac', '.m4a',
  '.mp4', '.webm', '.mov', '.avi', '.mkv',
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.pptx', '.potx', '.ppsx', '.docx', '.xlsx', '.xlsm',
  '.sqlite', '.db', '.bin', '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.parquet', '.pickle', '.pkl', '.npy', '.npz',
]);

const INSTRUCTIONS = `You annotate files in a user's personal workspace. Your annotations become
the title and description shown in file listings — they are how agents and
the user later understand what a file is without opening it.

You are given the file's relative path, size, modification time, and the
beginning of its content (it may be truncated — you never see past the
first few kilobytes).

Write:
- title: a short human-readable title, 2-6 words.
- description: 1-2 sentences: what the file is, what it contains, and what
  it is apparently for. For scripts: what the script does and, if evident,
  its command-line arguments. For data files: what a row/entry represents
  and the notable columns or fields.

Rules:
- Ground everything in what you actually see. Never invent purposes,
  origins or contents you cannot observe.
- If the content is unclear, describe what IS observable: format,
  structure, apparent domain.
- Write the annotation in the language that best matches the file's
  content and naming.`;

const ANNOTATION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['title', 'description'],
  additionalProperties: false,
} as const;

type CandidateFile = {
  relPath: string;
  sizeBytes: number;
  mtime: Date;
};

// ---------------------------------------------------------------------------
// File-area walk.
// ---------------------------------------------------------------------------

function isSkippedName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIR_NAMES.has(name);
}

async function walkFiles(absDir: string, relPrefix: string, out: CandidateFile[]): Promise<void> {
  if (out.length >= MAX_FILES_PER_USER) {
    return;
  }

  let entries;

  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return; // vanished mid-walk — the filesystem is the source of truth
  }

  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_USER) {
      return;
    }

    if (isSkippedName(entry.name)) {
      continue;
    }

    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      await walkFiles(path.join(absDir, entry.name), relPath, out);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const stats = await fs.stat(path.join(absDir, entry.name)).catch(() => null);

    if (!stats?.isFile() || stats.size === 0) {
      continue;
    }

    out.push({ relPath, sizeBytes: stats.size, mtime: stats.mtime });
  }
}

// ---------------------------------------------------------------------------
// Head reading: the first HEAD_BYTES of the file, never the whole content.
// ---------------------------------------------------------------------------

async function readHead(absPath: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle;

  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return null;
  }

  try {
    const stats = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stats.size, HEAD_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);

    // Extension lists lie; the content decides. NUL bytes or a heavy share
    // of control characters mean binary — skip, exactly as a binary extension.
    if (looksBinary(head)) {
      return null;
    }

    let text = head.toString('utf8');
    const truncated = stats.size > bytesRead;

    if (truncated) {
      // A multi-byte character cut at the read boundary decodes as U+FFFD.
      text = text.replace(/�+$/, '');
    }

    return { text, truncated };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function looksBinary(head: Buffer): boolean {
  const window = head.subarray(0, 1_000);
  let control = 0;

  for (const byte of window) {
    if (byte === 0) {
      return true;
    }

    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      control += 1;
    }
  }

  return window.length > 0 && control / window.length > 0.1;
}

// ---------------------------------------------------------------------------
// The model call: one file per call, strict JSON output.
// ---------------------------------------------------------------------------

async function annotate(candidate: CandidateFile, head: string, truncated: boolean): Promise<{ title: string; description: string } | null> {
  const input = [
    `Path: ${candidate.relPath}`,
    `Size: ${candidate.sizeBytes} bytes`,
    `Modified: ${candidate.mtime.toISOString()}`,
    `Content${truncated ? ` (truncated — first ${Math.round(HEAD_BYTES / 1000)}KB only)` : ''}:`,
    '<<<',
    head,
    '>>>',
  ].join('\n');

  const response = await getOpenaiClient().responses.create(
    {
      model: config.indexerOpenaiModel,
      instructions: INSTRUCTIONS,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'file_annotation',
          strict: true,
          schema: ANNOTATION_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    },
    { timeout: MODEL_TIMEOUT_MS },
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(response.output_text);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).title !== 'string' ||
    typeof (parsed as Record<string, unknown>).description !== 'string'
  ) {
    return null;
  }

  const { title, description } = parsed as { title: string; description: string };

  return title.trim() && description.trim() ? { title: title.trim(), description: description.trim() } : null;
}

// ---------------------------------------------------------------------------
// The pass: all users, freshness-filtered, capped model calls.
// ---------------------------------------------------------------------------

async function runPass(isStopped: () => boolean): Promise<void> {
  let annotated = 0;
  let failed = 0;
  let capped = false;

  let userIds: string[];

  try {
    const entries = await fs.readdir(workspaceRoot(), { withFileTypes: true });

    userIds = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  } catch {
    return; // no workspace root yet — nothing to index
  }

  for (const userId of userIds) {
    if (isStopped() || capped) {
      break;
    }

    const filesDir = workspaceFilesDir(userId);
    const filesDirStats = await fs.stat(filesDir).catch(() => null);

    if (!filesDirStats?.isDirectory()) {
      continue;
    }

    const files: CandidateFile[] = [];

    await walkFiles(filesDir, '', files);

    if (files.length >= MAX_FILES_PER_USER) {
      console.warn(`[indexer] user ${userId}: file walk hit the ${MAX_FILES_PER_USER}-file cap; the rest waits`);
    }

    const annotationTimes = await readAnnotationTimes(userId);
    const candidates = files.filter(file => {
      const annotatedAt = annotationTimes.get(file.relPath);

      return !annotatedAt || file.mtime > annotatedAt;
    });

    if (!candidates.length) {
      continue;
    }

    const dbPath = workspaceDbPath(userId);
    let dbReady = false;

    for (const candidate of candidates) {
      if (isStopped()) {
        return;
      }

      if (annotated + failed >= MAX_MODEL_CALLS_PER_PASS) {
        capped = true;
        break;
      }

      const head = await readHead(path.join(filesDir, candidate.relPath));

      if (!head) {
        continue; // vanished or binary by content — not a candidate after all
      }

      try {
        const annotation = await annotate(candidate, head.text, head.truncated);

        if (!annotation) {
          failed += 1;
          continue;
        }

        if (!dbReady) {
          ensureFilesDb(dbPath);
          dbReady = true;
        }

        upsertMeta(dbPath, candidate.relPath, annotation.title, annotation.description);
        annotated += 1;
      } catch (error) {
        failed += 1;
        console.error(`[indexer] failed to annotate ${userId}/${candidate.relPath}:`, error);
      }
    }
  }

  if (annotated || failed) {
    console.log(
      `[indexer] pass done: ${annotated} annotated, ${failed} failed${capped ? ' (call cap reached, the rest waits for the next pass)' : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The service: a setTimeout loop; a failed pass logs and waits for the next.
// ---------------------------------------------------------------------------

export function startWorkspaceIndexer(): { name: string; stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout;

  const loop = async () => {
    try {
      await runPass(() => stopped);
    } catch (error) {
      console.error('[indexer] pass failed:', error);
    }

    if (!stopped) {
      timer = setTimeout(loop, PASS_INTERVAL_MS);
    }
  };

  timer = setTimeout(loop, FIRST_PASS_DELAY_MS);

  return {
    name: 'workspace-indexer',
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
