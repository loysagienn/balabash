// The node `workspace_files`: the workspace file area for an agent without
// its own disk and shell — read, write, list, look at and delete one file.
// The area itself is the workspace layer's (src/workspace/files.ts): the
// listing, the node of a file, the annotations (a title and a description
// per file) and the write that replaces a file in one step.

import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { CapabilityError, WorkspacePath, capability, namedType, node } from '../catalog/index.ts';
import {
  deleteMeta,
  listDir,
  replaceFileContent,
  statFile,
  upsertMeta,
  withFileWriteLock,
  type WorkspaceFileNode,
} from '../workspace/files.ts';
import { absolutePath, areaPath, provideFolder, provideWorkbench, writingDatabase } from './file-area.ts';

export const WorkspaceFile = namedType(
  'WorkspaceFile',
  { description: 'One file of the workspace file area: no content, only what describes it.' },
  z.strictObject({
    path: WorkspacePath,
    sizeBytes: z.int().nullable().describe('null when the file could not be read.'),
    modifiedAt: z.string().nullable().describe('ISO 8601.'),
    title: z.string().nullable(),
    description: z.string().nullable().describe('What the file is; for a script, what it does and its arguments.'),
  }),
);

export type WorkspaceFileValue = z.input<typeof WorkspaceFile>;

function workspaceFileValue(file: WorkspaceFileNode): WorkspaceFileValue {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    title: file.title,
    description: file.description,
  };
}

function noFile(relPath: string): CapabilityError {
  return new CapabilityError('not_found', `There is no file at "${relPath}" in the workspace file area.`);
}

// The longest content `read` returns, in characters.
const READ_MAX_CHARS = 50_000;
// A character of UTF-8 takes at most four bytes; one more character than the
// limit tells a file that ends at the limit from one that goes on.
const READ_MAX_BYTES = (READ_MAX_CHARS + 1) * 4;

const read = capability({
  name: 'read',
  summary: 'Read a text file of the workspace file area',
  description: 'Read a text file of the workspace file area as UTF-8, up to 50 000 characters.',
  input: z.strictObject({ path: WorkspacePath }),
  output: z.strictObject({
    content: z.string(),
    truncated: z.boolean().describe('true: the file is longer than what was returned.'),
    sizeBytes: z.int().describe('Size of the whole file.'),
  }),
  async run(input, { caller }) {
    const relPath = areaPath(input.path);
    const handle = await fs.open(absolutePath(caller.workspaceId, relPath), 'r').catch(() => null);

    if (!handle) {
      throw noFile(relPath);
    }

    try {
      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw noFile(relPath);
      }

      const buffer = Buffer.alloc(Math.min(stats.size, READ_MAX_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const whole = bytesRead >= stats.size;
      // A character cut by the end of the buffer is held back, not decoded
      // into a replacement mark; at the real end of the file nothing is held.
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(buffer.subarray(0, bytesRead)) + (whole ? decoder.end() : '');

      if (text.length <= READ_MAX_CHARS) {
        return { content: text, truncated: !whole, sizeBytes: stats.size };
      }

      // The cut never lands inside a character written as a surrogate pair.
      const last = text.charCodeAt(READ_MAX_CHARS - 1);
      const end = last >= 0xd800 && last <= 0xdbff ? READ_MAX_CHARS - 1 : READ_MAX_CHARS;

      return { content: text.slice(0, end), truncated: true, sizeBytes: stats.size };
    } finally {
      await handle.close();
    }
  },
});

const write = capability({
  name: 'write',
  summary: 'Create or replace a text file, or change its title and description',
  description:
    'Create or replace a text file of the workspace file area. With `content` the file is written whole; without it only the title and description of an existing file change. An omitted title or description keeps its value.',
  input: z.strictObject({
    path: WorkspacePath,
    content: z.string().optional(),
    title: z.string().optional(),
    description: z.string().describe('What the file is; for a script, what it does and its arguments.').optional(),
  }),
  inputRules: [{ atLeastOne: ['content', 'title', 'description'] }],
  output: WorkspaceFile,
  async run(input, { caller }) {
    const { workspaceId } = caller;
    const relPath = areaPath(input.path);
    const { content } = input;

    // An annotation that is given says something; there is no call that
    // clears one.
    for (const field of ['title', 'description'] as const) {
      if (input[field] !== undefined && !input[field].trim()) {
        throw new CapabilityError('invalid_input', `${field} is blank: pass a value or leave the field out.`);
      }
    }

    const { dbPath } = await provideWorkbench(workspaceId);

    if (content !== undefined) {
      await provideFolder(workspaceId, relPath);

      // The file changes in one step: a reader sees the old content or the
      // new one.
      await withFileWriteLock(workspaceId, relPath, () => replaceFileContent(workspaceId, relPath, Buffer.from(content, 'utf8'))).catch(
        error => {
          const code = (error as NodeJS.ErrnoException).code;

          if (code === 'EISDIR' || code === 'ENOTEMPTY' || code === 'ENOTDIR') {
            throw new CapabilityError('conflict', `The path "${relPath}" is taken by a directory.`);
          }

          throw error;
        },
      );
    }

    const written = await statFile(workspaceId, relPath);

    if (!written) {
      throw new CapabilityError(
        'not_found',
        `There is no file at "${relPath}" in the workspace file area: pass content to create it.`,
      );
    }

    // The annotation is stamped whenever it has, or gets, something to
    // keep: the stamp is what holds it against the background annotator,
    // which rewrites an annotation older than its file. A file written
    // without one, and never annotated, is left for the annotator.
    const annotates = input.title !== undefined || input.description !== undefined;

    if (!annotates && written.title === null && written.description === null) {
      return workspaceFileValue(written);
    }

    const meta = await writingDatabase(
      content === undefined ? 'the title and description are unchanged' : 'the content is written, the title and description are not',
      () => upsertMeta(dbPath, relPath, input.title?.trim() ?? null, input.description?.trim() ?? null),
    );

    return workspaceFileValue({ ...written, ...meta });
  },
});

const list = capability({
  name: 'list',
  summary: 'List one directory of the workspace file area',
  description:
    'List one directory of the workspace file area, not recursively: its subdirectories and its files, sorted by name.',
  input: z.strictObject({
    path: WorkspacePath.describe('Default: the root of the file area.').optional(),
  }),
  output: z.strictObject({
    directories: z.array(WorkspacePath),
    files: z.array(WorkspaceFile),
  }),
  async run(input, { caller }) {
    const relDir = input.path === undefined ? '' : areaPath(input.path);
    const listing = await listDir(caller.workspaceId, relDir);

    if (!listing) {
      throw new CapabilityError('not_found', `There is no directory at "${relDir}" in the workspace file area.`);
    }

    return {
      // The listing names its folders; a value carries their paths.
      directories: listing.directories.map(name => (relDir ? `${relDir}/${name}` : name)),
      files: listing.files.map(workspaceFileValue),
    };
  },
});

const stat = capability({
  name: 'stat',
  summary: 'Get the size, modification time, title and description of one file',
  description: 'Get the size, modification time, title and description of one file.',
  input: z.strictObject({ path: WorkspacePath }),
  output: WorkspaceFile,
  async run(input, { caller }) {
    const relPath = areaPath(input.path);
    const file = await statFile(caller.workspaceId, relPath);

    if (!file) {
      throw noFile(relPath);
    }

    return workspaceFileValue(file);
  },
});

const remove = capability({
  name: 'delete',
  summary: 'Delete one file of the workspace file area',
  description:
    'Delete one file of the workspace file area together with its title and description. Directories are not deleted.',
  input: z.strictObject({ path: WorkspacePath }),
  output: z.null(),
  async run(input, { caller }) {
    const relPath = areaPath(input.path);
    const absPath = absolutePath(caller.workspaceId, relPath);
    // The entry itself, not what a link points to: deleting a link removes
    // the link.
    const stats = await fs.lstat(absPath).catch(() => null);

    if (stats?.isDirectory()) {
      throw new CapabilityError('invalid_input', `"${relPath}" is a directory: only a file is deleted here.`);
    }

    // The annotation goes first, so a call that cannot write it deletes
    // nothing — and the one a file deleted elsewhere left behind goes too,
    // though the call still finds no file.
    await writingDatabase('nothing is deleted', () => deleteMeta(caller.workspaceId, [relPath]));

    if (!stats) {
      throw noFile(relPath);
    }

    await fs.rm(absPath, { force: true });

    return null;
  },
});

export const workspaceFiles = node({
  name: 'files',
  summary: 'The workspace file area for an agent without its own disk and shell: read, write, list and delete files.',
  guide: [
    { text: 'Look before you write: `workspace_files_list` shows what exists, with titles and descriptions.' },
    {
      text: 'Keep related files together in a directory and give scripts and long-lived files a title and a description; for a script, describe its arguments.',
    },
    {
      text: 'Mechanical work over data — paginated downloads, parsing, bulk transforms, file generation — goes into a script run with `workspace_run_command`. Keep large data in files or tables and print only the requested excerpt or a compact summary.',
      requires: ['workspace_run_command'],
    },
    {
      text: 'A large file is not read whole: extract the part you need with a script, or load it into the database and read slices with `workspace_query`.',
      requires: ['workspace_query'],
    },
    {
      text: '`workspace_files_write` takes text only; binary content arrives through `import_file` or is produced by a script.',
      requires: ['import_file'],
    },
  ],
  children: [read, write, list, stat, remove],
});
