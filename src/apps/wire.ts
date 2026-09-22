// The JSON wire of the data gateway on the way OUT: {result} serialized
// here (not by Koa) so a large answer — the bulk window of endpoints.ts,
// megabytes of rows — leaves gzipped when the browser accepts it. Small
// answers stay plain: below the threshold compression costs more than it
// saves, and the ordinary 50 KB window never reaches it. Streaming gzip
// keeps the event loop free of a synchronous multi-megabyte deflate; the
// browser's fetch decodes transparently (sdk/data.ts reads response.json()).

import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

/** Serialized responses of at least this many characters are gzipped. */
export const GZIP_MIN_CHARS = 32_000;

export type EncodedJson = { encoding: null; body: string } | { encoding: 'gzip'; body: Readable };

/** True when the Accept-Encoding header names gzip (any q other than 0). */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) {
    return false;
  }

  return acceptEncoding.split(',').some(part => {
    const [name = '', ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));

    return (name.trim() === 'gzip' || name.trim() === '*') && q !== 'q=0' && q !== 'q=0.0';
  });
}

/**
 * The body for one JSON response: the string itself, or a gzip stream of
 * it when it is large and the client accepts gzip.
 */
export function encodeJsonResponse(json: string, acceptEncoding: string | undefined): EncodedJson {
  if (json.length < GZIP_MIN_CHARS || !acceptsGzip(acceptEncoding)) {
    return { encoding: null, body: json };
  }

  return { encoding: 'gzip', body: Readable.from([json]).pipe(createGzip()) };
}
