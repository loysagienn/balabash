// The body of an upload as a stream: the bytes of a file sent as the whole
// request body (the console's XHR), never held in memory. Shared by the two
// uploads of the web surface — to the file area (POST /files/<rel>) and to
// storage (POST /api/files): the size limit counted while reading, the
// client that left midway, and a full disk told apart from a failure.

import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { IncomingMessage } from 'node:http';

// The body went past what the request may carry: the limit of an upload, or
// the length the request itself declared.
export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
}

// The body passed through a counter: past `limit` bytes the stream fails
// with BodyTooLargeError, so the consumer (a temp file, a PutObject) stops
// and nothing is kept.
export function limitedBody(request: IncomingMessage, limit: number): NodeJS.ReadableStream {
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      seen += chunk.length;

      if (seen > limit) {
        done(new BodyTooLargeError(`The body is larger than ${limit} bytes`));

        return;
      }

      done(null, chunk);
    },
  });

  // The client gone midway: the request is destroyed without an end — the
  // counter fails too, so whoever reads it fails instead of waiting.
  request.on('close', () => {
    if (!request.complete) {
      counter.destroy(new Error('The client closed the upload'));
    }
  });
  request.on('error', error => counter.destroy(error));

  return request.pipe(counter);
}

// The declared length of the body: a number, null when absent, NaN when it is
// not a length at all.
export function declaredLength(header: string): number | null {
  if (header === '') {
    return null;
  }

  return /^\d+$/.test(header) ? Number(header) : Number.NaN;
}

// The upload ended because the client left (a cancel in the console, a
// closed tab, the connection lost): nobody waits for an answer.
export function clientLeft(request: IncomingMessage): boolean {
  return !request.complete && (request.destroyed || request.socket?.destroyed === true);
}

// The volume refused the bytes for want of space — said to the user as
// such ("Not enough space on the server"), not as a failure of the app.
export function isNoSpace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  return code === 'ENOSPC' || code === 'EDQUOT';
}
