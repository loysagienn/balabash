// File storage: one of two drivers behind one API, chosen by configuration.
// `spaces` — the S3-compatible object
// store of the original with presigned download URLs; `local` — the local
// disk of the fork with signed links onto the web surface. The files row
// records the driver in `bucket` (the Spaces bucket name, or "local") and
// the object key in `objectKey` (an S3 key, or the path relative to
// FILES_ROOT): a row is always read by the driver that wrote it, so an
// installation may switch drivers and keep its old files readable.

import { config } from '../config/index.ts';
import * as spaces from './storage/spaces.ts';
import * as local from './storage/local.ts';

export type StorageBody = spaces.StorageBody;

const DEFAULT_PRESIGN_TTL_SECONDS = 900;

// SigV4 presigned URLs cannot outlive 7 days; Spaces enforces the same cap,
// and the local signed links keep the same ceiling.
export const MAX_PRESIGN_TTL_SECONDS = spaces.MAX_PRESIGN_TTL_SECONDS;

// The bucket new files are written into: the configured Spaces bucket, or
// the local driver's marker.
export function getStorageBucket(): string {
  return config.fileStorage === 'spaces' ? spaces.getStorageBucket() : local.LOCAL_BUCKET;
}

function isLocal(bucket: string): boolean {
  return bucket === local.LOCAL_BUCKET;
}

export async function uploadStorageObject(input: {
  bucket: string;
  key: string;
  body: StorageBody;
  contentType?: string | null;
  contentLength?: number | null;
  cacheControl?: string | null;
}): Promise<{ ETag?: string; sizeBytes?: number }> {
  if (isLocal(input.bucket)) {
    // The local driver measures what it wrote; the caller's contentLength
    // is a claim (a gzip-compressed download reports the wire size).
    const { etag, sizeBytes } = await local.writeLocalObject(config.filesRoot, input.key, input.body as local.LocalStorageBody);

    return { ETag: etag, sizeBytes };
  }

  return spaces.uploadStorageObject(input);
}

export async function deleteStorageObject(bucket: string, key: string): Promise<void> {
  if (isLocal(bucket)) {
    await local.deleteLocalObject(config.filesRoot, key);

    return;
  }

  await spaces.deleteStorageObject(bucket, key);
}

export async function getStorageObject(bucket: string, key: string): Promise<ReadableStream<Uint8Array>> {
  if (isLocal(bucket)) {
    return local.openLocalObject(config.filesRoot, key);
  }

  return spaces.getStorageObject(bucket, key);
}

// Size of a stored object in bytes, without fetching its content.
export async function getStorageObjectSize(bucket: string, key: string): Promise<number | null> {
  if (isLocal(bucket)) {
    return local.localObjectSize(config.filesRoot, key);
  }

  return spaces.getStorageObjectSize(bucket, key);
}

export async function getStorageDownloadUrl(input: {
  bucket: string;
  key: string;
  // The files row id — the address of a local signed link.
  fileId: string;
  filename?: string | null;
  expiresInSeconds?: number;
}): Promise<{ url: string; expiresAt: Date }> {
  const expiresInSeconds = Math.min(input.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS, MAX_PRESIGN_TTL_SECONDS);

  if (isLocal(input.bucket)) {
    return local.signDownloadLink({
      origin: `https://${config.domain}`,
      secret: config.sessionPepper,
      fileId: input.fileId,
      expiresInSeconds,
    });
  }

  return spaces.getStorageDownloadUrl({ ...input, expiresInSeconds });
}
