// Files layer — port of v1: binary content lives in the configured storage
// (Spaces or the local disk, storage.ts), the log and every consumer operate
// on fileId (§9). Database access goes straight to Prisma:
// the files table is this module's private state.

import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../db/client.ts';
import type { FileRef } from '../core/contract.ts';
import type { FileModel } from '../../prisma-generated/models.ts';
import {
  deleteStorageObject,
  getStorageBucket,
  getStorageDownloadUrl,
  getStorageObject,
  getStorageObjectSize,
  uploadStorageObject,
  type StorageBody,
} from './storage.ts';

type FileMetadata = {
  workspaceId?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  originalFilename?: string | null;
  scope?: string | null;
  width?: number | null;
  height?: number | null;
};

type IngestFileInput = FileMetadata & {
  body: StorageBody;
  cacheControl?: string | null;
  // Cuts the upload of the bytes. Once storage has taken them the file is
  // recorded whatever the signal says: a file is stored or it is not.
  signal?: AbortSignal;
};

type DownloadUrlOptions = {
  expiresInSeconds?: number;
};

const normalizeObjectKey = (objectKey: string) => {
  return objectKey.replace(/^\/+/, '');
};

// In bytes of UTF-8: the last segment of the key is a file name on the disk
// of the local driver, and a file system counts a name in bytes (255).
const MAX_OBJECT_KEY_FILENAME_BYTES = 200;
const MAX_OBJECT_KEY_EXTENSION_BYTES = 20;

// The longest beginning of the text that fits the bytes, cut at a character.
const fitBytes = (text: string, maxBytes: number): string => {
  let fitted = '';
  let bytes = 0;

  for (const character of text) {
    bytes += Buffer.byteLength(character);

    if (bytes > maxBytes) {
      break;
    }

    fitted += character;
  }

  return fitted;
};

// Turns a user-supplied filename into a safe last path segment for the object
// key. That final segment is what Telegram shows when it fetches the file by
// URL, so we keep a readable name (unicode allowed) while stripping path- and
// URL-hostile characters. Returns null when nothing usable remains.
const sanitizeObjectKeyFilename = (originalFilename: string): string | null => {
  // Keep only the last path segment (defends against "../.." style names).
  const basename = originalFilename.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, '') // control characters
    .replace(/[<>:"|?*#%]/g, '_') // path- and URL-hostile characters
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '') // no leading dots ("..", hidden files)
    .trim();

  if (!cleaned) {
    return null;
  }

  if (Buffer.byteLength(cleaned) <= MAX_OBJECT_KEY_FILENAME_BYTES) {
    return cleaned;
  }

  // Preserve the extension while shortening.
  const dotIndex = cleaned.lastIndexOf('.');
  const extension = dotIndex > 0 ? fitBytes(cleaned.slice(dotIndex), MAX_OBJECT_KEY_EXTENSION_BYTES) : '';
  return fitBytes(cleaned, MAX_OBJECT_KEY_FILENAME_BYTES - Buffer.byteLength(extension)) + extension;
};

// The object key ends with the (sanitized) original filename so a client that
// fetches the file by URL — notably Telegram — shows a meaningful name. The
// UUID directory keeps keys unique, so same-named files never collide.
const buildObjectKey = (scope?: string | null, originalFilename?: string | null) => {
  const randomName = crypto.randomUUID();
  const prefix = scope ? `${scope}/${randomName}` : randomName;
  const safeFilename = originalFilename ? sanitizeObjectKeyFilename(originalFilename) : null;

  if (safeFilename) {
    return normalizeObjectKey(`${prefix}/${safeFilename}`);
  }

  const extension = originalFilename ? path.extname(originalFilename) : '';
  return normalizeObjectKey(`${prefix}${extension}`);
};

// The one FileRef of the platform (§9, core/contract.ts): the model's fields
// without bucket/objectKey, dates as ISO strings.
function toFileRef(file: FileModel): FileRef {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    etag: file.etag,
    originalFilename: file.originalFilename,
    scope: file.scope,
    width: file.width,
    height: file.height,
    uploadedAt: file.uploadedAt?.toISOString() ?? null,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

// The expected refusal of a lookup — no such row, a row not yet uploaded, a
// row of another workspace — as opposed to the store failing to answer at all:
// a caller translating refusals (the API's 404) must let a failure through.
export class FileNotFoundError extends Error {
  constructor(fileId: string, reason = 'not found') {
    super(`File "${fileId}" ${reason}`);
    this.name = 'FileNotFoundError';
  }
}

async function requireFile(fileId: string): Promise<FileModel> {
  const file = await prisma.file.findUnique({ where: { id: fileId } });

  if (!file) {
    throw new FileNotFoundError(fileId);
  }

  if (!file.uploadedAt) {
    throw new FileNotFoundError(fileId, 'is not uploaded');
  }

  return file;
}

export async function ingestFile({
  body,
  contentType,
  sizeBytes,
  originalFilename,
  scope,
  workspaceId,
  width,
  height,
  cacheControl,
  signal,
}: IngestFileInput): Promise<FileRef> {
  const bucket = getStorageBucket();
  const objectKey = buildObjectKey(scope, originalFilename);

  // An object without a row is bytes nobody can name: whichever of the two
  // steps fails, the object does not stay behind.
  const dropObject = () =>
    deleteStorageObject(bucket, objectKey).catch((error: unknown) => {
      console.warn(`[files] the object "${objectKey}" could not be dropped after a failed ingest:`, error);
    });

  let uploadResult: Awaited<ReturnType<typeof uploadStorageObject>>;

  try {
    uploadResult = await uploadStorageObject({
      bucket,
      key: objectKey,
      body,
      contentType,
      contentLength: sizeBytes ?? undefined,
      cacheControl,
      signal,
    });
  } catch (error) {
    // An upload that failed on this side — cut by the signal, its answer
    // lost — may have landed on the other.
    await dropObject();

    throw error;
  }

  try {
    const fileRecord = await prisma.file.create({
      data: {
        bucket,
        objectKey,
        workspaceId: workspaceId ?? undefined,
        contentType: contentType ?? undefined,
        sizeBytes: uploadResult.sizeBytes ?? sizeBytes ?? undefined,
        etag: uploadResult.ETag ?? undefined,
        originalFilename: originalFilename ?? undefined,
        scope: scope ?? undefined,
        width: width ?? undefined,
        height: height ?? undefined,
        uploadedAt: new Date(),
      },
    });

    return toFileRef(fileRecord);
  } catch (error) {
    // The failure of an insert does not say whether the row was written (a
    // connection lost on the commit): the key does. A row that is there is
    // the stored file; without one the object goes; when even that cannot
    // be told, the object stays — it may be a file's content.
    const written = await prisma.file.findUnique({ where: { bucket_objectKey: { bucket, objectKey } } }).catch(() => undefined);

    if (written) {
      return toFileRef(written);
    }

    if (written === null) {
      await dropObject();
    }

    throw error;
  }
}

export async function getFile(fileId: string): Promise<FileRef> {
  return toFileRef(await requireFile(fileId));
}

// Size in bytes: the recorded value, or — for files ingested without one — a
// HeadObject on the stored object, remembered on the row so the next lookup
// is a plain read. Null only when the object itself reports no length.
export async function getFileSizeBytes(fileId: string): Promise<number | null> {
  const file = await requireFile(fileId);

  if (file.sizeBytes !== null) {
    return file.sizeBytes;
  }

  const sizeBytes = await getStorageObjectSize(file.bucket, normalizeObjectKey(file.objectKey));

  if (sizeBytes !== null) {
    await prisma.file.update({ where: { id: fileId }, data: { sizeBytes } });
  }

  return sizeBytes;
}

// Workspace-scoped lookup for model-supplied file ids (§6): a fileId coming
// from an LLM call must not cross the user boundary, and the existence of a
// foreign file is not leaked — same error as a missing one.
export async function getWorkspaceFile(workspaceId: string, fileId: string): Promise<FileRef> {
  const file = await requireFile(fileId);

  if (file.workspaceId !== workspaceId) {
    throw new FileNotFoundError(fileId);
  }

  return toFileRef(file);
}

export async function getFileDownloadUrl(fileId: string, options: DownloadUrlOptions = {}) {
  const file = await requireFile(fileId);

  return getStorageDownloadUrl({
    bucket: file.bucket,
    key: normalizeObjectKey(file.objectKey),
    fileId: file.id,
    filename: file.originalFilename,
    expiresInSeconds: options.expiresInSeconds,
  });
}

export async function openFileContent(fileId: string): Promise<ReadableStream<Uint8Array>> {
  const file = await requireFile(fileId);

  return getStorageObject(file.bucket, normalizeObjectKey(file.objectKey));
}

export async function deleteFile(fileId: string): Promise<void> {
  const file = await requireFile(fileId);

  await deleteStorageObject(file.bucket, normalizeObjectKey(file.objectKey));
  await prisma.file.delete({ where: { id: fileId } });
}
