// Stored files: the reference a value carries, and the capabilities of the
// root that act on a stored file — one capability per action, the same value
// for every caller. A file in a value is a reference, never the content;
// the path in the workspace file area is the local form of a file, and the
// two capabilities of the bridge turn one into the other.

import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { CapabilityError, FileId, FileRef, WorkspacePath, capability, type Caller, type FileRefValue } from '../catalog/index.ts';
import type { FileRef as StoredFile } from '../core/contract.ts';
import { FileNotFoundError, getFileDownloadUrl, getWorkspaceFile, ingestFile, openFileContent } from '../files/index.ts';
import { UPLOAD_MAX_BYTES } from '../utils/file-names.ts';
import {
  WorkspacePathError,
  fileDigest,
  guessContentType,
  placeImport,
  placeUpload,
  receiveUpload,
  sanitizeRelPath,
  withFileWriteLock,
} from '../workspace/files.ts';
import { absolutePath, areaPath, orAbsent, provideFolder, provideWorkbench } from './file-area.ts';

export function fileRefValue(file: StoredFile): FileRefValue {
  return {
    kind: 'file',
    id: file.id,
    name: file.originalFilename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
  };
}

// The references of the stored files with these ids, in the order given. A
// file the workspace does not have (any more) is left out: a reference
// names a file that can be taken.
export async function workspaceFileRefs(workspaceId: string, fileIds: string[]): Promise<FileRefValue[]> {
  const refs: FileRefValue[] = [];

  for (const fileId of fileIds) {
    try {
      refs.push(fileRefValue(await getWorkspaceFile(workspaceId, fileId)));
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) {
        throw error;
      }
    }
  }

  return refs;
}

// A stored file of the caller's workspace by the id an input names; a file
// of another workspace answers the same as a missing one.
export async function storedFile(caller: Caller, fileId: string): Promise<StoredFile> {
  try {
    return await getWorkspaceFile(caller.workspaceId, fileId);
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      throw new CapabilityError('not_found', `There is no stored file "${fileId}" in the workspace.`);
    }

    throw error;
  }
}

// An optional text field that is given carries a value.
function given(field: string, value: string | undefined): string | undefined {
  if (value !== undefined && !value.trim()) {
    throw new CapabilityError('invalid_input', `${field} is blank: pass a value or leave the field out.`);
  }

  return value?.trim();
}

const exportFile = capability({
  name: 'export_file',
  summary: 'Store a file of the workspace file area and get its reference',
  description:
    'Store a file of the workspace file area in Balabash storage and get its reference: the way a file you produced reaches the user or another agent. The reference fixes the content as of the call.',
  input: z.strictObject({
    path: WorkspacePath,
    name: z.string().describe('Filename the stored file carries. Default: the last segment of path.').optional(),
    contentType: z.string().describe('MIME type. Default: guessed from the name.').optional(),
  }),
  output: FileRef,
  async run(input, { caller }) {
    const relPath = areaPath(input.path);
    const absPath = absolutePath(caller.workspaceId, relPath);
    const absent = () => new CapabilityError('not_found', `There is no file at "${relPath}" in the workspace file area.`);
    // One open file for the look and for the bytes: a file replaced under
    // this name meanwhile does not give its bytes under the other's size.
    const handle = await orAbsent(fs.open(absPath, 'r'));

    if (!handle) {
      throw absent();
    }

    try {
      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw absent();
      }

      if (stats.size > UPLOAD_MAX_BYTES) {
        throw new CapabilityError(
          'invalid_input',
          `The file at "${relPath}" is ${stats.size} bytes: larger than a stored file can be (${UPLOAD_MAX_BYTES} bytes).`,
        );
      }

      const name = given('name', input.name) ?? relPath.slice(relPath.lastIndexOf('/') + 1);
      const contentType = given('contentType', input.contentType) ?? guessContentType(name);

      // The bytes are copied into storage: what the file becomes afterwards
      // does not reach the reference.
      const stored = await ingestFile({
        body: handle.createReadStream({ autoClose: false }),
        workspaceId: caller.workspaceId,
        originalFilename: name,
        contentType,
        sizeBytes: stats.size,
        scope: 'workspace',
      });

      return fileRefValue(stored);
    } finally {
      await handle.close();
    }
  },
});

// Where a stored file lands when the call names no path: under imports/ by
// its stored name, or by its id when the name cannot be a path of the area.
function defaultImportPath(file: StoredFile): string {
  const basename = file.originalFilename?.split(/[/\\]/).pop()?.trim();

  if (basename) {
    try {
      return sanitizeRelPath(`imports/${basename}`);
    } catch (error) {
      if (!(error instanceof WorkspacePathError)) {
        throw error;
      }
    }
  }

  return `imports/${file.id}`;
}

const importFile = capability({
  name: 'import_file',
  summary: 'Put a stored file into the workspace file area',
  description:
    'Put a stored file into the workspace file area, to work with its content there. With `path` the file is written exactly there and replaces a file already at that path. Without it the file lands under imports/ by its stored name, and nothing is overwritten.',
  input: z.strictObject({
    file: FileId,
    path: WorkspacePath.describe('Destination.').optional(),
  }),
  output: z.strictObject({ path: WorkspacePath.describe('Where the file landed.') }),
  async run(input, { caller }) {
    const { workspaceId } = caller;
    const destination = input.path === undefined ? null : areaPath(input.path);
    const file = await storedFile(caller, input.file);
    const relPath = destination ?? defaultImportPath(file);

    await provideWorkbench(workspaceId);
    await provideFolder(workspaceId, relPath);

    // The bytes arrive beside the area and take their place in one step: a
    // reader of the area never sees half a file, and a failed download
    // leaves the area as it was.
    const content = Readable.fromWeb((await openFileContent(file.id)) as Parameters<typeof Readable.fromWeb>[0]);
    const temp = await receiveUpload(workspaceId, content);

    // A path the call names is the caller's choice: the file there is
    // replaced. A folder or a link under the name is not a file to replace.
    if (destination !== null) {
      const placed = await withFileWriteLock(workspaceId, destination, () => placeUpload(workspaceId, destination, temp, 'replace'));

      if (placed.kind !== 'placed') {
        throw new CapabilityError('conflict', `The path "${destination}" is taken by something that is not a file.`);
      }

      return { path: placed.path };
    }

    // Without one nothing is overwritten: the file takes the first name
    // that is free — or that already holds the same bytes, the same import
    // done before.
    const digest = await fileDigest(temp).catch(async error => {
      await fs.rm(temp, { force: true });
      throw error;
    });

    return { path: (await placeImport(workspaceId, relPath, temp, digest)).path };
  },
});

const getFileUrl = capability({
  name: 'get_file_url',
  summary: 'Get a temporary download address of a stored file',
  description:
    'Get a temporary download address of a stored file, for a program or an outside system that fetches the bytes itself. The address needs no authorization and stops working at `expiresAt`.',
  input: z.strictObject({ file: FileId }),
  output: z.strictObject({
    url: z.string(),
    expiresAt: z.string().describe('ISO 8601.'),
  }),
  async run(input, { caller }) {
    const file = await storedFile(caller, input.file);
    const { url, expiresAt } = await getFileDownloadUrl(file.id);

    return { url, expiresAt: expiresAt.toISOString() };
  },
});

// ---------------------------------------------------------------------------
// view_file. The value is the reference; the content is the port's to
// attach to the answer, for the model alone. What can be shown is decided
// here, once, so every port shows the same files.

export type ViewKind = 'image' | 'pdf' | 'text';

// The longest text a port shows, from the start of the file.
export const VIEW_TEXT_MAX_CHARS = 50_000;

const VIEWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Text that does not call itself text/*.
const TEXT_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/javascript',
  'application/x-sh',
]);

// How a stored file is shown, by its type: the recorded one, or — for a file
// stored without a telling type — the one its name gives. null: the file is
// neither an image a model takes, a PDF nor text.
export function viewKind(file: Pick<StoredFile, 'contentType' | 'originalFilename'>): ViewKind | null {
  const recorded = file.contentType?.split(';')[0]?.trim().toLowerCase() || null;
  const type =
    recorded && recorded !== 'application/octet-stream' ? recorded : guessContentType(file.originalFilename ?? '');

  if (VIEWED_IMAGE_TYPES.has(type)) {
    return 'image';
  }

  if (type === 'application/pdf') {
    return 'pdf';
  }

  return type.startsWith('text/') || TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml') ? 'text' : null;
}

const viewFile = capability({
  name: 'view_file',
  summary: 'Show yourself a stored image, PDF or text file',
  description:
    "Show yourself a stored image (JPEG, PNG, GIF, WebP), PDF or text file. The content is attached to the answer to this call only; the value is the file's reference. A long text is shown from its start, up to 50 000 characters.",
  input: z.strictObject({ file: FileId }),
  output: FileRef,
  async run(input, { caller }) {
    const file = await storedFile(caller, input.file);

    if (!viewKind(file)) {
      throw new CapabilityError(
        'invalid_input',
        `The file "${file.id}" (${file.contentType ?? 'no content type'}) is neither an image (JPEG, PNG, GIF, WebP), a PDF nor text: it cannot be shown.`,
      );
    }

    return fileRefValue(file);
  },
});

export const fileCapabilities = { exportFile, importFile, getFileUrl, viewFile };
