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
  userId?: string | null;
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
};

type DownloadUrlOptions = {
  expiresInSeconds?: number;
};

const normalizeObjectKey = (objectKey: string) => {
  return objectKey.replace(/^\/+/, '');
};

const MAX_OBJECT_KEY_FILENAME_LENGTH = 200;

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

  if (cleaned.length <= MAX_OBJECT_KEY_FILENAME_LENGTH) {
    return cleaned;
  }

  // Preserve the extension while shortening.
  const dotIndex = cleaned.lastIndexOf('.');
  const extension = dotIndex > 0 ? cleaned.slice(dotIndex).slice(0, 20) : '';
  return cleaned.slice(0, MAX_OBJECT_KEY_FILENAME_LENGTH - extension.length) + extension;
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
    userId: file.userId,
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
// row of another user — as opposed to the store failing to answer at all:
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
  userId,
  width,
  height,
  cacheControl,
}: IngestFileInput): Promise<FileRef> {
  const bucket = getStorageBucket();
  const objectKey = buildObjectKey(scope, originalFilename);

  const uploadResult = await uploadStorageObject({
    bucket,
    key: objectKey,
    body,
    contentType,
    contentLength: sizeBytes ?? undefined,
    cacheControl,
  });

  const fileRecord = await prisma.file.create({
    data: {
      bucket,
      objectKey,
      userId: userId ?? undefined,
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
export async function getUserFile(userId: string, fileId: string): Promise<FileRef> {
  const file = await requireFile(fileId);

  if (file.userId !== userId) {
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
