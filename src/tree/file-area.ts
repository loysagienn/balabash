// The workspace file area as the tree reaches it: the path a caller names,
// and the workbench a write needs in place. The boundary of the area and its
// layout are the workspace layer's own (src/workspace/files.ts, layout.ts);
// here is what the catalog adds — a path has one form, and a refusal has a
// kind.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityError } from '../catalog/index.ts';
import { WorkspacePathError, ensureFilesDb, sanitizeRelPath } from '../workspace/files.ts';
import { workspaceDbPath, workspaceFilesDir, workspaceTmpDir } from '../workspace/layout.ts';
import { WorkspaceDbBusyError } from '../workspace/sqlite.ts';

// A WorkspacePath of an input, checked: relative, inside the area, and
// written the one way a result writes it — the path a call names is the
// path a value gives back, and it names the entry of the disk that carries
// exactly this name. The workspace layer tidies a path before use (white
// space around it, a backslash, a leading "./"), so a path it would change
// is refused here, not passed on to land on another entry. Only for "./"
// is the tidy form the same file and named as the way to write it; a name
// that really begins or ends with white space, or holds a backslash, is one
// these capabilities do not address — the refusal says so and points
// nowhere else.
export function areaPath(raw: string, field = 'path'): string {
  if (raw.includes('\0')) {
    throw new CapabilityError('invalid_input', `The ${field} holds a NUL character.`);
  }

  let tidy: string;

  try {
    tidy = sanitizeRelPath(raw, field);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw new CapabilityError('invalid_input', error.message);
    }

    throw error;
  }

  if (tidy === raw) {
    return tidy;
  }

  if (raw !== raw.trim()) {
    throw new CapabilityError(
      'invalid_input',
      `The ${field} "${raw}" begins or ends with white space, and a name like that is not addressed here. If the white space is not part of the name, pass the ${field} without it.`,
    );
  }

  if (raw.includes('\\')) {
    throw new CapabilityError(
      'invalid_input',
      `The ${field} "${raw}" holds a backslash, and a name with one is not addressed here. The folders of a path are separated by "/".`,
    );
  }

  throw new CapabilityError('invalid_input', `The ${field} "${raw}" is not in its plain form: write it as "${tidy}".`);
}

// Whether a failure of the file system says "there is nothing at this
// path": a missing entry, a file where a folder of the path should be, a
// name longer than a name can be. Anything else (no permission, no
// descriptors) is a failure of the read, not an absence.
export function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
}

// The outcome of a look at the file system, with absence as null.
export async function orAbsent<T>(look: Promise<T>): Promise<T | null> {
  try {
    return await look;
  } catch (error) {
    if (isAbsence(error)) {
      return null;
    }

    throw error;
  }
}

export function absolutePath(workspaceId: string, relPath: string): string {
  return path.join(workspaceFilesDir(workspaceId), relPath);
}

export type Workbench = {
  filesDir: string;
  dbPath: string;
};

// The workbench of the workspace, in place: the file area, the folder of
// transient files and the database with the table of file annotations. A
// capability that writes, or runs something in the area, calls this first;
// one that only reads does not — a missing area reads as an empty one.
export async function provideWorkbench(workspaceId: string): Promise<Workbench> {
  const workbench = { filesDir: workspaceFilesDir(workspaceId), dbPath: workspaceDbPath(workspaceId) };

  await fs.mkdir(workbench.filesDir, { recursive: true });
  await fs.mkdir(workspaceTmpDir(workspaceId), { recursive: true });
  await writingDatabase('nothing was done', () => ensureFilesDb(workbench.dbPath));

  return workbench;
}

// The folder a file is about to be written into, created with its parents.
// A file standing where a folder of the path should be is the state of the
// area, not a defect.
export async function provideFolder(workspaceId: string, relPath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(absolutePath(workspaceId, relPath)), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new CapabilityError('conflict', `A folder of the path "${relPath}" is taken by a file.`);
    }

    if (code === 'ENAMETOOLONG') {
      throw nameTooLong(relPath);
    }

    throw error;
  }
}

export function nameTooLong(relPath: string): CapabilityError {
  return new CapabilityError('invalid_input', `A name in the path "${relPath}" is longer than the file system takes.`);
}

// A write of the workspace database made on the caller's behalf. Another
// writer holding the database for the whole wait is the state of the
// workspace, not a defect: `undone` names what this leaves unwritten.
export async function writingDatabase<T>(undone: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof WorkspaceDbBusyError) {
      throw new CapabilityError(
        'conflict',
        `Another writer held the workspace database locked for the whole wait: ${undone}. Call again once it commits.`,
      );
    }

    throw error;
  }
}
