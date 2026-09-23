// Spaces (S3-compatible) object storage — port of v1 files/storage. The
// endpoint host is derived from the region; buckets are private, downloads go
// through short-lived presigned URLs.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index.ts';

export type StorageBody = PutObjectCommandInput['Body'];

const DEFAULT_PRESIGN_TTL_SECONDS = 900;

// SigV4 presigned URLs cannot outlive 7 days; Spaces enforces the same cap.
export const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

export function getStorageBucket(): string {
  return config.spacesBucketName;
}

function createStorageClient(): S3Client {
  return new S3Client({
    region: config.spacesRegion,
    endpoint: `https://${config.spacesRegion}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId: config.spacesAccessKeyId,
      secretAccessKey: config.spacesAccessKeySecret,
    },
  });
}

export async function uploadStorageObject(input: {
  bucket: string;
  key: string;
  body: StorageBody;
  contentType?: string | null;
  contentLength?: number | null;
  cacheControl?: string | null;
}) {
  return createStorageClient().send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType ?? undefined,
      ContentLength: input.contentLength ?? undefined,
      CacheControl: input.cacheControl ?? undefined,
      ACL: 'private',
    }),
  );
}

export async function deleteStorageObject(bucket: string, key: string): Promise<void> {
  await createStorageClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getStorageObject(bucket: string, key: string) {
  return createStorageClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

// Size of a stored object in bytes, without fetching its content.
export async function getStorageObjectSize(bucket: string, key: string): Promise<number | null> {
  const head = await createStorageClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

  return head.ContentLength ?? null;
}

export async function getStorageDownloadUrl(input: {
  bucket: string;
  key: string;
  filename?: string | null;
  expiresInSeconds?: number;
}): Promise<{ url: string; expiresAt: Date }> {
  const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
  const command = new GetObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ResponseContentDisposition: input.filename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`
      : undefined,
  });

  return {
    url: await getSignedUrl(createStorageClient(), command, { expiresIn: expiresInSeconds }),
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
}
