// The local-disk storage driver (from the fork): binary content lives under
// FILES_ROOT (files/ in the repository root by default, gitignored), the
// object key of the files row is the path relative to that root — one
// uuid-named directory per file, so same-named files never collide. There
// are no presigned URLs: a download link is a signed link onto the web
// surface (/files/dl/<fileId>?exp=…&sig=…, served by Koa without a session)
// — the secret is the link itself, as with a presigned URL. Selected by
// FILE_STORAGE=local (the default without SPACES_*); see ../storage.ts.
//
// Pure functions parameterized by the root and the signing secret: the
// dispatcher binds the config, the tests bind a temp dir.

import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type LocalStorageBody = NodeJS.ReadableStream | Uint8Array | string;

// The bucket column of a locally stored file: the driver's name, so a row
// written by one driver is never read by the other.
export const LOCAL_BUCKET = 'local';

export function resolveLocalPath(root: string, key: string): string {
  const filePath = path.resolve(root, key);
  const relative = path.relative(root, filePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Object key "${key}" resolves outside the file storage root`);
  }

  return filePath;
}

// Writes the body under root/key; returns the byte size and a content hash
// playing the role of S3's ETag (the files row records it).
export async function writeLocalObject(
  root: string,
  key: string,
  body: LocalStorageBody,
): Promise<{ sizeBytes: number; etag: string }> {
  const filePath = resolveLocalPath(root, key);

  await mkdir(path.dirname(filePath), { recursive: true });

  const source = typeof body === 'string' || body instanceof Uint8Array ? Readable.from([body]) : body;
  const hash = crypto.createHash('md5');
  const hashing = async function* (chunks: AsyncIterable<Buffer | string>) {
    for await (const chunk of chunks) {
      hash.update(chunk);
      yield chunk;
    }
  };

  await pipeline(source, hashing, createWriteStream(filePath, { flags: 'wx' }));

  const { size } = await stat(filePath);

  return { sizeBytes: size, etag: `"${hash.digest('hex')}"` };
}

export function openLocalObject(root: string, key: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(resolveLocalPath(root, key))) as ReadableStream<Uint8Array>;
}

export async function localObjectSize(root: string, key: string): Promise<number | null> {
  try {
    return (await stat(resolveLocalPath(root, key))).size;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

// Removes the object; the uuid directory that held it goes too (it never
// holds anything else). A missing object is a no-op.
export async function deleteLocalObject(root: string, key: string): Promise<void> {
  const filePath = resolveLocalPath(root, key);

  await rm(filePath, { force: true });

  const parent = path.dirname(filePath);

  if (path.resolve(parent) !== path.resolve(root)) {
    // Best-effort: rmdir only removes an empty directory.
    await rmdir(parent).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Signed download links: HMAC-SHA256 over "<fileId>:<exp>" with the
// installation secret; exp is the expiry as epoch seconds. The verifier is
// the Koa route GET /files/dl/:fileId (src/api/api.ts).

function linkSignature(secret: string, fileId: string, exp: number): string {
  return crypto.createHmac('sha256', secret).update(`${fileId}:${exp}`).digest('base64url');
}

export function signDownloadLink(input: {
  origin: string; // https://<domain>
  secret: string;
  fileId: string;
  expiresInSeconds: number;
}): { url: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
  const sig = linkSignature(input.secret, input.fileId, exp);
  const url = `${input.origin.replace(/\/$/, '')}/files/dl/${encodeURIComponent(input.fileId)}?exp=${exp}&sig=${sig}`;

  return { url, expiresAt: new Date(exp * 1000) };
}

export function verifyDownloadLink(input: {
  secret: string;
  fileId: string;
  exp: string | undefined;
  sig: string | undefined;
  now?: number;
}): boolean {
  const exp = Number(input.exp);

  if (!Number.isInteger(exp) || !input.sig) {
    return false;
  }

  if (exp * 1000 <= (input.now ?? Date.now())) {
    return false;
  }

  const expected = Buffer.from(linkSignature(input.secret, input.fileId, exp));
  const given = Buffer.from(input.sig);

  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
