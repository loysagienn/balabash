// Files layer — port of v1: binary content lives in Spaces, the log and every
// consumer operate on fileId (§9). Database access goes straight to Prisma:
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

async function requireFile(fileId: string): Promise<FileModel> {
  const file = await prisma.file.findUnique({ where: { id: fileId } });

  if (!file) {
    throw new Error(`File "${fileId}" not found`);
  }

  if (!file.uploadedAt) {
    throw new Error(`File "${fileId}" is not uploaded`);
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
      sizeBytes: sizeBytes ?? undefined,
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

// Workspace-scoped lookup for model-supplied file ids (§6): a fileId coming
// from an LLM call must not cross the user boundary, and the existence of a
// foreign file is not leaked — same error as a missing one.
export async function getUserFile(userId: string, fileId: string): Promise<FileRef> {
  const file = await requireFile(fileId);

  if (file.userId !== userId) {
    throw new Error(`File "${fileId}" not found`);
  }

  return toFileRef(file);
}

export async function getFileDownloadUrl(fileId: string, options: DownloadUrlOptions = {}) {
  const file = await requireFile(fileId);

  return getStorageDownloadUrl({
    bucket: file.bucket,
    key: normalizeObjectKey(file.objectKey),
    filename: file.originalFilename,
    expiresInSeconds: options.expiresInSeconds,
  });
}

export async function openFileContent(fileId: string): Promise<ReadableStream<Uint8Array>> {
  const file = await requireFile(fileId);
  const result = await getStorageObject(file.bucket, normalizeObjectKey(file.objectKey));

  if (!result.Body) {
    throw new Error(`File "${fileId}" has no content`);
  }

  return result.Body.transformToWebStream();
}

export async function deleteFile(fileId: string): Promise<void> {
  const file = await requireFile(fileId);

  await deleteStorageObject(file.bucket, normalizeObjectKey(file.objectKey));
  await prisma.file.delete({ where: { id: fileId } });
}
