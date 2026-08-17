import http from 'node:http';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ToolError, toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import type { FileRef } from '../src/core/contract.ts';

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 300;

const DEFAULT_MAX_FILE_BYTES = 100_000_000;
const MIN_MAX_FILE_BYTES = 1_000;
const MAX_MAX_FILE_BYTES = 300_000_000;

const MAX_REDIRECTS = 5;
const MAX_FILENAME_LENGTH = 150;
const FILE_SCOPE = 'downloads';

const USER_AGENT = 'Balabash-DownloadFile/1.0 (MCP tool)';

type ErrorKind =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'blocked_address'
  | 'dns_error'
  | 'network_error'
  | 'tls_error'
  | 'timeout'
  | 'redirect_error'
  | 'too_many_redirects'
  | 'http_error'
  | 'file_too_large'
  | 'empty_body'
  | 'storage_error';

class DownloadError extends Error {
  kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Balabash files API surface (per tools/AGENTS.md).
// ---------------------------------------------------------------------------

type ToolFilesApi = {
  ingest: (input: {
    body: NodeJS.ReadableStream | Buffer | Uint8Array | string;
    userId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    scope?: string | null;
    width?: number | null;
    height?: number | null;
  }) => Promise<FileRef>;
};

// The calling run's identity rides in the MCP request _meta (set by the tool
// manager for local servers). A stored file must belong to that workspace —
// an ownerless file cannot be delivered back to the user.
function callerUserId(extra: { _meta?: Record<string, unknown> }): string | null {
  const balabash = extra._meta?.balabash;
  const userId =
    balabash && typeof balabash === 'object' && !Array.isArray(balabash)
      ? (balabash as Record<string, unknown>).userId
      : undefined;

  return typeof userId === 'string' && userId ? userId : null;
}

// ---------------------------------------------------------------------------
// SSRF protection: block requests that resolve to private, loopback,
// link-local, or otherwise non-public addresses. Mirrors tools/http_get.ts.
// ---------------------------------------------------------------------------

const blockedAddresses = new BlockList();
// IPv4.
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local (cloud metadata)
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blockedAddresses.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blockedAddresses.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blockedAddresses.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blockedAddresses.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
blockedAddresses.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
blockedAddresses.addSubnet('224.0.0.0', 3, 'ipv4'); // multicast + reserved + broadcast
// IPv6.
blockedAddresses.addSubnet('::', 127, 'ipv6'); // unspecified + loopback (::, ::1)
// Note: no explicit IPv4-mapped (::ffff:0:0/96) subnet — BlockList canonicalizes
// mapped addresses and checks them against the IPv4 subnets above automatically.
blockedAddresses.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
blockedAddresses.addSubnet('100::', 64, 'ipv6'); // discard-only
blockedAddresses.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blockedAddresses.addSubnet('2002::', 16, 'ipv6'); // 6to4 (deprecated)
blockedAddresses.addSubnet('fc00::', 7, 'ipv6'); // unique local
blockedAddresses.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockedAddresses.addSubnet('ff00::', 8, 'ipv6'); // multicast

function isBlockedAddress(rawAddress: string): boolean {
  // Strip an IPv6 zone id like "fe80::1%eth0".
  const address = rawAddress.split('%')[0];
  const family = isIP(address);

  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family === 6) return blockedAddresses.check(address, 'ipv6');

  // Unparseable address: refuse rather than guess.
  return true;
}

function parseTargetUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new DownloadError('invalid_url', `Not a valid absolute URL: "${rawUrl}".`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError(
      'unsupported_protocol',
      `Unsupported protocol "${url.protocol}"; only http: and https: URLs can be downloaded.`,
    );
  }

  if (url.username || url.password) {
    throw new DownloadError(
      'invalid_url',
      'URLs with embedded credentials (user:password@host) are not allowed.',
    );
  }

  return url;
}

/**
 * Validates that the URL's host resolves only to public addresses. Re-run for
 * every redirect hop. (A small DNS TOCTOU/rebinding window remains — the same
 * accepted limitation as tools/http_get.ts.)
 */
async function assertPublicTarget(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new DownloadError(
        'blocked_address',
        `Address ${hostname} is a private/internal address; downloading from it is blocked to prevent SSRF.`,
      );
    }
    return;
  }

  let addresses: { address: string }[];

  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new DownloadError(
      'dns_error',
      code === 'ENOTFOUND'
        ? `DNS lookup failed: host "${hostname}" not found.`
        : `DNS lookup for "${hostname}" failed${code ? ` (${code})` : ''}.`,
    );
  }

  if (addresses.length === 0) {
    throw new DownloadError('dns_error', `DNS lookup for "${hostname}" returned no addresses.`);
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new DownloadError(
        'blocked_address',
        `Host "${hostname}" resolves to ${address}, a private/internal address; downloading from it is blocked to prevent SSRF.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Filename determination: Content-Disposition -> URL path -> mime fallback.
// ---------------------------------------------------------------------------

const MIME_EXTENSIONS: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/xml': '.xml',
  'application/octet-stream': '.bin',
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

/** Strips path components and dangerous characters, bounds the length. */
function sanitizeFilename(raw: string): string | null {
  // Keep only the last path segment (defends against "..\..\evil" style names).
  const basename = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, '') // control characters
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '') // no leading dots ("..", hidden files)
    .trim();

  if (!cleaned) return null;

  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  // Preserve the extension while shortening.
  const dotIndex = cleaned.lastIndexOf('.');
  const extension = dotIndex > 0 ? cleaned.slice(dotIndex).slice(0, 20) : '';
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

/** Parses a Content-Disposition header: RFC 5987 filename* first, then filename. */
function filenameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) return null;

  const extendedMatch = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(headerValue);
  if (extendedMatch) {
    const value = extendedMatch[2].trim().replace(/^"|"$/g, '');
    try {
      return sanitizeFilename(decodeURIComponent(value));
    } catch {
      // Malformed percent-encoding — fall through to plain filename.
    }
  }

  const plainMatch = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(headerValue);
  if (plainMatch) {
    const value = (plainMatch[1] ?? plainMatch[2] ?? '').replace(/\\(.)/g, '$1').trim();
    if (value) return sanitizeFilename(value);
  }

  return null;
}

function filenameFromUrl(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;

  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment when percent-decoding fails.
  }

  return sanitizeFilename(decoded);
}

function determineFilename(
  contentDisposition: string | null,
  finalUrl: URL,
  mimeType: string | null,
): string {
  const fromHeader = filenameFromContentDisposition(contentDisposition);
  if (fromHeader) return fromHeader;

  const fromUrl = filenameFromUrl(finalUrl);
  if (fromUrl) return fromUrl;

  const extension = (mimeType && MIME_EXTENSIONS[mimeType]) || '';
  return `download${extension}`;
}

function parseContentType(headerValue: string | null): string | null {
  if (!headerValue) return null;
  return headerValue.split(';')[0].trim().toLowerCase() || null;
}

// ---------------------------------------------------------------------------
// Download with manual, validated redirects, timeout, and hard size cap.
// ---------------------------------------------------------------------------

function mapFetchError(error: unknown, url: URL, timedOut: () => boolean): DownloadError {
  if (error instanceof DownloadError) return error;

  if (timedOut()) {
    return new DownloadError('timeout', `Request to ${url} timed out.`);
  }

  const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
  const code = cause?.code ?? (error as NodeJS.ErrnoException)?.code;

  if (code && /CERT|TLS|SSL|HANDSHAKE/i.test(code)) {
    return new DownloadError('tls_error', `TLS error while connecting to ${url.host}: ${code}.`);
  }

  const detail =
    code ??
    (cause instanceof Error ? cause.message : undefined) ??
    (error instanceof Error ? error.message : String(error));

  return new DownloadError('network_error', `Network error while downloading ${url}: ${detail}.`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type DownloadOutcome = {
  finalUrl: URL;
  contentType: string | null;
  contentDisposition: string | null;
  // Known-size bodies stream straight to storage; unknown-size bodies are
  // buffered in memory, bounded by the size limit.
  body: NodeJS.ReadableStream | Buffer;
  sizeBytes: number;
  // The DownloadError that broke the body stream mid-ingest, if any.
  streamFailure: () => DownloadError | null;
};

async function downloadWithPolicy(
  rawUrl: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<DownloadOutcome> {
  const requestedUrl = parseTargetUrl(rawUrl);
  const controller = new AbortController();
  let timedOut = false;
  // When the body is returned as a stream, its consumer owns the timer.
  let bodyHandedToStream = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let currentUrl = requestedUrl;

  try {
    for (let hop = 0; ; hop += 1) {
      // Re-validate the target address on every hop, including redirects.
      await assertPublicTarget(currentUrl);

      if (timedOut) throw new DownloadError('timeout', `Request to ${requestedUrl} timed out.`);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: '*/*',
            // The file must be stored as-is, and fetch transparently
            // decompresses encoded bodies, making Content-Length unusable.
            'accept-encoding': 'identity',
          },
        });
      } catch (error) {
        throw mapFetchError(error, currentUrl, () => timedOut);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});

        if (!location) {
          throw new DownloadError(
            'redirect_error',
            `Redirect (${response.status}) from ${currentUrl} has no Location header.`,
          );
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new DownloadError(
            'redirect_error',
            `Redirect from ${currentUrl} points to an invalid Location: "${location}".`,
          );
        }

        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new DownloadError(
            'redirect_error',
            `Redirect from ${currentUrl} points to unsupported protocol "${nextUrl.protocol}".`,
          );
        }

        if (hop + 1 > MAX_REDIRECTS) {
          throw new DownloadError(
            'too_many_redirects',
            `Stopped after ${MAX_REDIRECTS} redirects; last target was ${nextUrl}.`,
          );
        }

        currentUrl = nextUrl;
        continue;
      }

      // A download must not silently save an error page: non-2xx is an error.
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadError(
          'http_error',
          `Download failed: ${currentUrl} responded with HTTP ${response.status} ${response.statusText}.`,
        );
      }

      // Content-Length of an encoded body is the wire size, not the file
      // size: if a server compresses despite accept-encoding: identity, the
      // decompressed length is unknown and the buffered path takes over.
      const rawContentLength = response.headers.get('content-length');
      const contentEncoding = response.headers.get('content-encoding');
      const parsedLength = rawContentLength === null ? NaN : Number(rawContentLength);
      const declaredLength =
        Number.isInteger(parsedLength) && (!contentEncoding || contentEncoding === 'identity')
          ? parsedLength
          : null;

      // Fail fast when the server already declares an oversized body.
      if (declaredLength !== null && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadError(
          'file_too_large',
          `File is ${declaredLength} bytes (from Content-Length), which exceeds the limit of ${maxBytes} bytes.`,
        );
      }

      if (!response.body || declaredLength === 0) {
        await response.body?.cancel().catch(() => {});
        throw new DownloadError(
          'empty_body',
          `The response from ${currentUrl} contained no body; nothing was saved.`,
        );
      }

      const finalUrl = currentUrl;
      const reader = response.body.getReader();
      let failure: DownloadError | null = null;

      const readBody = async function* (): AsyncGenerator<Uint8Array> {
        let totalBytes = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new DownloadError(
                'file_too_large',
                `Download aborted: the file exceeds the limit of ${maxBytes} bytes. ` +
                  'A partially downloaded file is never saved.',
              );
            }
            yield value;
          }
        } catch (error) {
          if (error instanceof DownloadError) {
            failure = error;
          } else if (timedOut) {
            failure = new DownloadError(
              'timeout',
              `Request to ${requestedUrl} timed out while downloading the file body.`,
            );
          } else {
            failure = new DownloadError(
              'network_error',
              `Connection failed while downloading from ${finalUrl}: ${
                error instanceof Error ? error.message : String(error)
              }.`,
            );
          }
          throw failure;
        } finally {
          clearTimeout(timer);
        }
      };

      const baseOutcome = {
        finalUrl,
        contentType: parseContentType(response.headers.get('content-type')),
        contentDisposition: response.headers.get('content-disposition'),
        streamFailure: () => failure,
      };

      // With a declared size the body streams straight to storage without
      // buffering — S3 PutObject requires a known Content-Length.
      if (declaredLength !== null) {
        bodyHandedToStream = true;

        return {
          ...baseOutcome,
          body: Readable.from(readBody()),
          sizeBytes: declaredLength,
        };
      }

      // No usable Content-Length: buffer in memory, bounded by maxBytes.
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      for await (const value of readBody()) {
        chunks.push(value);
        totalBytes += value.byteLength;
      }

      if (totalBytes === 0) {
        throw new DownloadError(
          'empty_body',
          `The response from ${currentUrl} contained no body; nothing was saved.`,
        );
      }

      return {
        ...baseOutcome,
        body: Buffer.concat(chunks),
        sizeBytes: totalBytes,
      };
    }
  } finally {
    if (!bodyHandedToStream) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// MCP server.
// ---------------------------------------------------------------------------

function createMcpServer(filesApi: ToolFilesApi) {
  const server = new McpServer({ name: 'storage_download_file', version: '1.0.0' });

  server.registerTool(
    'storage_download_file',
    {
      description:
        'Download a file from a public http(s) URL into Balabash file storage and return its FileRef ' +
        '(id, originalFilename, contentType, sizeBytes, …). The id is a Balabash fileId — the address ' +
        'storage-side consumers understand (send_file, end_thread fileIds, storage_get_file). Use when a ' +
        'remote file (document, image, archive, media) must be stored for later use. To read raw API ' +
        'content, use http_get instead; for a file already in the workspace file area, use ' +
        'workspace_export_file.',
      inputSchema: {
        url: z.string().describe('Absolute http:// or https:// URL of the file to download.'),
        timeout_seconds: z
          .number()
          .nullable()
          .describe(
            `Total timeout in seconds for the whole download including redirects, ` +
              `${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS}. Pass null for the default (${DEFAULT_TIMEOUT_SECONDS}).`,
          ),
        max_file_bytes: z
          .number()
          .nullable()
          .describe(
            `Maximum allowed file size in bytes, ${MIN_MAX_FILE_BYTES}-${MAX_MAX_FILE_BYTES}. ` +
              `Pass null for the default (${DEFAULT_MAX_FILE_BYTES}). A larger file fails with an error; ` +
              'it is never truncated or partially saved.',
          ),
      },
    },
    async ({ url, timeout_seconds, max_file_bytes }, extra) => {
      const timeoutMs =
        Math.min(Math.max(timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) *
        1000;
      const maxBytes = Math.min(
        Math.max(max_file_bytes ?? DEFAULT_MAX_FILE_BYTES, MIN_MAX_FILE_BYTES),
        MAX_MAX_FILE_BYTES,
      );

      try {
        const outcome = await downloadWithPolicy(url, timeoutMs, maxBytes);
        const filename = determineFilename(outcome.contentDisposition, outcome.finalUrl, outcome.contentType);
        const contentType = outcome.contentType ?? 'application/octet-stream';

        let stored;
        try {
          stored = await filesApi.ingest({
            body: outcome.body,
            userId: callerUserId(extra),
            originalFilename: filename,
            contentType,
            sizeBytes: outcome.sizeBytes,
            scope: FILE_SCOPE,
          });
        } catch (error) {
          // A body-stream failure (limit, timeout, network) is a download
          // error; anything else went wrong on the storage side. A failed
          // upload saves nothing: the DB row is created only after success.
          throw (
            outcome.streamFailure() ??
            new DownloadError(
              'storage_error',
              `The file was downloaded but could not be saved to storage: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          );
        }

        // The one FileRef (§9), verbatim from the files layer.
        return toStructuredResult(stored);
      } catch (error) {
        return toErrorResult(
          error instanceof DownloadError ? new ToolError(error.message, { kind: error.kind }) : error,
        );
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP endpoint (per tools/AGENTS.md contract).
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

export async function start(ctx: { filesApi: ToolFilesApi }) {
  const httpServer = http.createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
      return;
    }

    const server = createMcpServer(ctx.filesApi);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw new Error('Local MCP server did not receive a TCP port');
  }

  return {
    config: {
      transport: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
