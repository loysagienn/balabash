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
// path a value gives back. A path the area would accept after tidying
// (a leading "./", a backslash, a space around it) is refused with the tidy
// form named: a caller that compares paths never meets two spellings.
export function areaPath(raw: string, field = 'path'): string {
  let tidy: string;

  try {
    tidy = sanitizeRelPath(raw, field);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw new CapabilityError('invalid_input', error.message);
    }

    throw error;
  }

  if (tidy !== raw) {
    throw new CapabilityError('invalid_input', `The ${field} "${raw}" is not in its plain form: write it as "${tidy}".`);
  }

  return tidy;
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
  await ensureFilesDb(workbench.dbPath);

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

    throw error;
  }
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
