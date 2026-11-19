// The node `web`: the public internet by address — a raw GET for APIs and
// feeds, and a remote file taken into storage. How a request is made, which
// addresses it reaches and how long it may take is web-request.ts; here is
// what each capability makes of the answer.

import { createReadStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { CapabilityError, FileRef, capability, node, type Node } from '../catalog/index.ts';
import { ingestFile } from '../files/index.ts';
import { guessContentType, receiveUpload } from '../workspace/files.ts';
import { fileRefValue, isTextType } from './files.ts';
import { callTime, internet, openPublicUrl, type Net, type WebAnswer } from './web-request.ts';

// The object keys of downloaded files in storage start with this.
const DOWNLOAD_SCOPE = 'downloads';

// The MIME type and the charset a Content-Type header names.
function contentTypeOf(header: string | undefined): { type: string | null; charset: string | null } {
  if (!header) {
    return { type: null, charset: null };
  }

  const charset = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim().toLowerCase() ?? null;

  return { type: header.split(';')[0]?.trim().toLowerCase() || null, charset };
}

// The length a Content-Length header declares.
function declaredLength(answer: WebAnswer): number | null {
  const header = answer.headers['content-length'];

  return header !== undefined && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
}

// ---------------------------------------------------------------------------
// get

// A body without a declared type is text unless its beginning — this many
// bytes — holds a NUL.
const SNIFFED_BYTES = 4096;

// The bytes of a text body as characters. A body cut at the byte limit may
// end inside a character: the cut-off bytes are dropped, not replaced.
function decodeText(bytes: Buffer, charset: string | null, cut: boolean): string {
  let decoder: TextDecoder;

  try {
    decoder = new TextDecoder(charset ?? 'utf-8');
  } catch {
    // A charset label nobody knows: UTF-8 is the best reading there is.
    decoder = new TextDecoder('utf-8');
  }

  return decoder.decode(bytes, { stream: cut });
}

const getOutput = z.strictObject({
  finalUrl: z.string().describe('The URL that answered, after redirects.'),
  redirectChain: z.array(z.strictObject({ url: z.string(), status: z.int(), location: z.string() })),
  status: z.int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()).describe('Names in lower case.'),
  contentType: z.string().nullable().describe('MIME type, without parameters.'),
  bodyKind: z.enum(['text', 'binary']),
  content: z.string().nullable().describe('null for a binary body.'),
  downloadedBytes: z.int().nullable(),
  truncated: z.boolean().describe('true: the body was cut at the byte limit.'),
  sizeBytes: z.int().nullable().describe('A binary body: its Content-Length.'),
});

function get(net: Net) {
  return capability({
    name: 'get',
    summary: 'Perform a raw HTTP GET and return the response as it is',
    description:
      'Perform a raw HTTP GET against a public URL and return the response as it is. Any status is a result, 4xx and 5xx included. Up to 5 redirects are followed. A text body is returned up to the byte limit; a binary body is not downloaded, only its metadata comes back.',
    input: z.strictObject({
      url: z.string(),
      timeoutSeconds: z.number().min(1).max(120).default(30).describe('For the whole request.'),
      maxContentBytes: z.int().min(1000).max(1_000_000).default(100_000),
    }),
    output: getOutput,
    async run(input, { signal }) {
      const time = callTime(input.timeoutSeconds, signal);
      const answer = await openPublicUrl(input.url, { net, time, acceptEncoding: 'gzip, deflate, br' });

      try {
        const { type, charset } = contentTypeOf(answer.headers['content-type']);
        const response = {
          finalUrl: answer.finalUrl.href,
          redirectChain: answer.redirectChain,
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers,
          contentType: type,
        };
        const binary = {
          ...response,
          bodyKind: 'binary' as const,
          content: null,
          downloadedBytes: null,
          truncated: false,
          sizeBytes: declaredLength(answer),
        };

        // A type that is not text, or a content coding this side cannot
        // take off: the body is not for reading, and is not downloaded.
        if ((type !== null && !isTextType(type)) || answer.coding !== null) {
          return binary;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        let arrived = 0;

        for await (const chunk of answer.chunks()) {
          // Told as the beginning arrives: a binary body is not read
          // further, however long the server takes to send the rest.
          if (type === null && arrived < SNIFFED_BYTES && chunk.subarray(0, SNIFFED_BYTES - arrived).includes(0)) {
            return binary;
          }

          arrived += chunk.length;

          if (size + chunk.length > input.maxContentBytes) {
            chunks.push(chunk.subarray(0, input.maxContentBytes - size));
            size = input.maxContentBytes;
            truncated = true;
            break;
          }

          chunks.push(chunk);
          size += chunk.length;
        }

        return {
          ...response,
          bodyKind: 'text' as const,
          content: decodeText(Buffer.concat(chunks), charset, truncated),
          downloadedBytes: size,
          truncated,
          sizeBytes: null,
        };
      } finally {
        answer.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// download

const FILENAME_MAX_LENGTH = 150;

const EXTENSIONS_BY_TYPE: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/xml': '.xml',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'text/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

// A name a server or a URL offers, as a filename: its last path segment,
// without control characters and characters a file system refuses, not
// hidden, of a bounded length with the extension kept.
function filename(raw: string): string | null {
  const cleaned = (raw.split(/[/\\]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned) {
    return null;
  }

  // Counted and cut by characters: a cut never leaves half of a surrogate
  // pair in the name.
  const characters = Array.from(cleaned);

  if (characters.length <= FILENAME_MAX_LENGTH) {
    return cleaned;
  }

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(cleaned.slice(dot)).slice(0, 20) : [];

  return [...characters.slice(0, FILENAME_MAX_LENGTH - extension.length), ...extension].join('');
}

// The filename of a Content-Disposition header: the extended form
// (filename*=charset''percent-encoded, RFC 5987) first, then the plain one.
function dispositionFilename(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)?.[2]?.trim().replace(/^"|"$/g, '');

  if (extended) {
    try {
      const name = filename(decodeURIComponent(extended));

      if (name) {
        return name;
      }
    } catch {
      // Broken percent-encoding: the plain form is tried.
    }
  }

  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const value = (plain?.[1] ?? plain?.[2] ?? '').replace(/\\(.)/g, '$1').trim();

  return value ? filename(value) : null;
}

function urlFilename(url: URL): string | null {
  const last = url.pathname.split('/').filter(Boolean).pop();

  if (!last) {
    return null;
  }

  try {
    return filename(decodeURIComponent(last));
  } catch {
    return filename(last);
  }
}

// The name the stored file carries: what the server calls it, else the last
// segment of the URL that answered, else a name by its type.
function downloadName(answer: WebAnswer, type: string | null): string {
  return (
    dispositionFilename(answer.headers['content-disposition']) ??
    urlFilename(answer.finalUrl) ??
    `download${(type && EXTENSIONS_BY_TYPE[type]) || ''}`
  );
}

const MAX_FILE_BYTES = 300_000_000;

function tooLarge(sizeBytes: number | null, maxFileBytes: number): CapabilityError {
  const advice = maxFileBytes < MAX_FILE_BYTES ? 'Raise maxFileBytes if the file is wanted.' : 'That is the largest file a download takes.';

  return new CapabilityError(
    'invalid_input',
    `The file is ${sizeBytes === null ? 'larger than' : `${sizeBytes} bytes, over`} the limit of ${maxFileBytes} bytes: nothing was stored. ${advice}`,
  );
}

// The bytes of the body, as long as they keep to the limit.
async function* withinLimit(answer: WebAnswer, maxFileBytes: number): AsyncGenerator<Buffer> {
  let size = 0;

  for await (const chunk of answer.chunks()) {
    size += chunk.length;

    if (size > maxFileBytes) {
      throw tooLarge(null, maxFileBytes);
    }

    yield chunk;
  }
}

function download(net: Net) {
  return capability({
    name: 'download',
    summary: 'Download a file from a public URL into storage',
    description:
      'Download a file from a public URL into Balabash storage and get its reference. Up to 5 redirects are followed. A response that is not 2xx, or a file over the size limit, fails as a whole: nothing partial is stored.',
    input: z.strictObject({
      url: z.string(),
      timeoutSeconds: z.number().min(1).max(300).default(60).describe('For the whole download.'),
      maxFileBytes: z.int().min(1000).max(MAX_FILE_BYTES).default(100_000_000),
    }),
    output: FileRef,
    async run(input, { caller, signal }) {
      const time = callTime(input.timeoutSeconds, signal);
      // The file is stored as the server keeps it, so no content coding is
      // asked for; one the server applies anyway is taken off.
      const answer = await openPublicUrl(input.url, { net, time, acceptEncoding: 'identity' });
      let temp: string | null = null;
      let content: ReadStream | null = null;

      try {
        if (answer.status < 200 || answer.status > 299) {
          throw new CapabilityError(
            'external_error',
            `${answer.finalUrl.href} answered ${answer.status}${answer.statusText ? ` ${answer.statusText}` : ''}: nothing was stored.`,
            { status: answer.status, statusText: answer.statusText, finalUrl: answer.finalUrl.href },
          );
        }

        if (answer.coding !== null) {
          throw new CapabilityError(
            'external_error',
            `${answer.finalUrl.href} sent the file in the content coding "${answer.coding}", which cannot be taken off here: nothing was stored.`,
          );
        }

        const declared = declaredLength(answer);

        // What the server declares over the limit is refused before a byte
        // is taken. A coded body declares the length of the coding.
        if (declared !== null && declared > input.maxFileBytes && !answer.headers['content-encoding']) {
          throw tooLarge(declared, input.maxFileBytes);
        }

        // The bytes arrive beside the storage and enter it whole: a
        // download that fails on the way leaves nothing behind.
        temp = await receiveUpload(caller.workspaceId, Readable.from(withinLimit(answer, input.maxFileBytes)));

        const { size } = await fs.stat(temp);

        if (size === 0) {
          throw new CapabilityError('external_error', `${answer.finalUrl.href} answered with an empty body: nothing was stored.`);
        }

        const { type } = contentTypeOf(answer.headers['content-type']);
        const name = downloadName(answer, type);
        // The time of the call covers the way into storage too: bytes
        // still on their way there when it runs out are dropped. A file
        // whose bytes storage has taken is stored, and the call answers
        // with it.
        content = createReadStream(temp);

        const stored = await ingestFile({
          body: content,
          workspaceId: caller.workspaceId,
          originalFilename: name,
          contentType: type ?? guessContentType(name),
          sizeBytes: size,
          scope: DOWNLOAD_SCOPE,
          signal: time.signal,
        }).catch((error: unknown) => {
          if (!time.signal.aborted) {
            throw error;
          }

          throw new CapabilityError(
            'unavailable',
            time.expired()
              ? `The file arrived, but storing it did not finish within ${input.timeoutSeconds} seconds: nothing was stored.`
              : 'The call was cancelled while the file was being stored: nothing was stored.',
          );
        });

        return fileRefValue(stored);
      } finally {
        answer.close();
        // An upload that was cut may not have closed what it was reading.
        content?.destroy();

        if (temp !== null) {
          // A copy that could not be removed is not the caller's failure:
          // the outcome of the call stands.
          await fs.rm(temp, { force: true }).catch((error: unknown) => {
            console.warn(`[web] the temporary copy of a download stays behind (${temp}):`, error);
          });
        }
      }
    },
  });
}

// The node over a network: the internet, or — in a test — a network of the
// test's own.
export function webNode(net: Net = internet): Node {
  return node({
    name: 'web',
    summary:
      'The public internet: raw HTTP GET for APIs and feeds, and downloading a remote file into storage. Come here to fetch something by its address.',
    guide: [
      {
        text: '`web_get` returns raw HTML: to read a web page, prefer a tool that converts HTML to readable text when you have one.',
      },
      {
        text: 'Only public addresses are reachable: private, loopback and link-local addresses are refused on every redirect hop.',
      },
    ],
    children: [get(net), download(net)],
  });
}

export const web = webNode();
