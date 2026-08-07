import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 120;

const DEFAULT_MAX_CONTENT_BYTES = 100_000;
const MIN_MAX_CONTENT_BYTES = 1_000;
const MAX_MAX_CONTENT_BYTES = 1_000_000;

const MAX_REDIRECTS = 5;

const USER_AGENT = 'Balabash-WebFetch/1.0 (+https://github.com/; MCP tool)';

type ErrorKind =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'blocked_address'
  | 'dns_error'
  | 'network_error'
  | 'tls_error'
  | 'timeout'
  | 'redirect_error'
  | 'too_many_redirects';

class WebFetchError extends Error {
  kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// SSRF protection: block requests that resolve to private, loopback,
// link-local, or otherwise non-public addresses.
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
// mapped addresses and checks them against the IPv4 subnets above automatically
// (and an explicit ::ffff:0:0/96 ipv6 subnet would wrongly match every IPv4 address).
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

  // BlockList also checks IPv4-mapped IPv6 addresses (::ffff:a.b.c.d and
  // ::ffff:xxxx:xxxx) against the registered IPv4 subnets.
  if (family === 6) return blockedAddresses.check(address, 'ipv6');

  // Unparseable address: refuse rather than guess.
  return true;
}

function parseTargetUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchError('invalid_url', `Not a valid absolute URL: "${rawUrl}".`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError(
      'unsupported_protocol',
      `Unsupported protocol "${url.protocol}"; only http: and https: URLs can be fetched.`,
    );
  }

  if (url.username || url.password) {
    throw new WebFetchError(
      'invalid_url',
      'URLs with embedded credentials (user:password@host) are not allowed.',
    );
  }

  return url;
}

/**
 * Validates that the URL's host resolves only to public addresses.
 * Note: this checks DNS before the request (a small TOCTOU/rebinding window
 * remains, which is an accepted limitation of this in-process tool).
 */
async function assertPublicTarget(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new WebFetchError(
        'blocked_address',
        `Address ${hostname} is a private/internal address; fetching it is blocked to prevent SSRF.`,
      );
    }
    return;
  }

  let addresses: { address: string }[];

  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new WebFetchError(
      'dns_error',
      code === 'ENOTFOUND'
        ? `DNS lookup failed: host "${hostname}" not found.`
        : `DNS lookup for "${hostname}" failed${code ? ` (${code})` : ''}.`,
    );
  }

  if (addresses.length === 0) {
    throw new WebFetchError('dns_error', `DNS lookup for "${hostname}" returned no addresses.`);
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new WebFetchError(
        'blocked_address',
        `Host "${hostname}" resolves to ${address}, a private/internal address; fetching it is blocked to prevent SSRF.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Content-type helpers.
// ---------------------------------------------------------------------------

const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/x-ndjson',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-www-form-urlencoded',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
  'image/svg+xml',
]);

function parseContentType(headerValue: string | null): { mimeType: string | null; charset: string | null } {
  if (!headerValue) return { mimeType: null, charset: null };
  const mimeType = headerValue.split(';')[0].trim().toLowerCase() || null;
  const charsetMatch = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(headerValue);
  return { mimeType, charset: charsetMatch ? charsetMatch[1].trim().toLowerCase() : null };
}

function isTextualMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    TEXTUAL_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}

/** Heuristic for responses without a Content-Type: binary if NUL bytes appear early. */
function looksLikeText(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 4096);
  return !probe.includes(0);
}

function decodeBody(bytes: Uint8Array, charset: string | null): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown charset label — fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------------------
// Fetch with manual, validated redirects, timeout, and size cap.
// ---------------------------------------------------------------------------

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) result[name] = value;
  const setCookie = headers.getSetCookie();
  if (setCookie.length > 0) result['set-cookie'] = setCookie.join('\n');
  return result;
}

function mapFetchError(error: unknown, url: URL, timedOut: () => boolean): WebFetchError {
  if (error instanceof WebFetchError) return error;

  if (timedOut()) {
    return new WebFetchError('timeout', `Request to ${url} timed out.`);
  }

  const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
  const code = cause?.code ?? (error as NodeJS.ErrnoException)?.code;

  if (code && /CERT|TLS|SSL|HANDSHAKE/i.test(code)) {
    return new WebFetchError('tls_error', `TLS error while connecting to ${url.host}: ${code}.`);
  }

  const detail =
    code ??
    (cause instanceof Error ? cause.message : undefined) ??
    (error instanceof Error ? error.message : String(error));

  return new WebFetchError('network_error', `Network error while fetching ${url}: ${detail}.`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchOutcome = {
  requestedUrl: string;
  finalUrl: string;
  redirectChain: { url: string; status: number; location: string }[];
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** False when the Content-Type declared non-text content and the body was not downloaded. */
  bodyRead: boolean;
  bodyBytes: Uint8Array;
  truncated: boolean;
};

async function fetchWithPolicy(rawUrl: string, timeoutMs: number, maxBytes: number): Promise<FetchOutcome> {
  const requestedUrl = parseTargetUrl(rawUrl);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const redirectChain: { url: string; status: number; location: string }[] = [];
  let currentUrl = requestedUrl;

  try {
    for (let hop = 0; ; hop += 1) {
      await assertPublicTarget(currentUrl);

      if (timedOut) throw new WebFetchError('timeout', `Request to ${requestedUrl} timed out.`);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: '*/*',
            'accept-language': 'en,ru;q=0.8',
          },
        });
      } catch (error) {
        throw mapFetchError(error, currentUrl, () => timedOut);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});

        if (!location) {
          throw new WebFetchError(
            'redirect_error',
            `Redirect (${response.status}) from ${currentUrl} has no Location header.`,
          );
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new WebFetchError(
            'redirect_error',
            `Redirect from ${currentUrl} points to an invalid Location: "${location}".`,
          );
        }

        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new WebFetchError(
            'redirect_error',
            `Redirect from ${currentUrl} points to unsupported protocol "${nextUrl.protocol}".`,
          );
        }

        redirectChain.push({ url: currentUrl.toString(), status: response.status, location: nextUrl.toString() });

        if (hop + 1 > MAX_REDIRECTS) {
          throw new WebFetchError(
            'too_many_redirects',
            `Stopped after ${MAX_REDIRECTS} redirects; last target was ${nextUrl}. ` +
              `Chain: ${redirectChain.map(entry => entry.url).join(' -> ')} -> ${nextUrl}`,
          );
        }

        currentUrl = nextUrl;
        continue;
      }

      // Final response. Policy: for a declared non-text Content-Type the body
      // is not downloaded at all — only metadata is returned.
      const { mimeType } = parseContentType(response.headers.get('content-type'));
      const declaredBinary = mimeType !== null && !isTextualMimeType(mimeType);

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      if (declaredBinary) {
        await response.body?.cancel().catch(() => {});
      } else if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              chunks.push(value.subarray(0, value.byteLength - (totalBytes - maxBytes)));
              truncated = true;
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
          }
        } catch (error) {
          if (timedOut) {
            throw new WebFetchError('timeout', `Request to ${requestedUrl} timed out while reading the response body.`);
          }
          throw new WebFetchError(
            'network_error',
            `Connection failed while reading the response body from ${currentUrl}: ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }

      return {
        requestedUrl: requestedUrl.toString(),
        finalUrl: currentUrl.toString(),
        redirectChain,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        bodyRead: !declaredBinary,
        bodyBytes: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
        truncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP server.
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({ name: 'web_fetch', version: '1.0.0' });

  server.registerTool(
    'web_fetch',
    {
      description:
        'Fetch a public http(s) URL with GET and return the response: status, headers, and body text ' +
        '(metadata only for binary content). Use whenever you need to read a web page, call an API, ' +
        'or inspect an HTTP response. To store a remote file instead of reading it, use download_file.',
      inputSchema: {
        url: z.string().describe('Absolute http:// or https:// URL to fetch.'),
        timeout_seconds: z
          .number()
          .nullable()
          .describe(
            `Total timeout in seconds for the whole request including redirects and body download, ` +
              `${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS}. Pass null for the default (${DEFAULT_TIMEOUT_SECONDS}).`,
          ),
        max_content_bytes: z
          .number()
          .nullable()
          .describe(
            `Maximum number of body bytes to download and return, ${MIN_MAX_CONTENT_BYTES}-${MAX_MAX_CONTENT_BYTES}. ` +
              `Pass null for the default (${DEFAULT_MAX_CONTENT_BYTES}). Larger bodies are truncated.`,
          ),
      },
    },
    async ({ url, timeout_seconds, max_content_bytes }) => {
      const timeoutMs =
        Math.min(Math.max(timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) *
        1000;
      const maxBytes = Math.min(
        Math.max(max_content_bytes ?? DEFAULT_MAX_CONTENT_BYTES, MIN_MAX_CONTENT_BYTES),
        MAX_MAX_CONTENT_BYTES,
      );

      try {
        const outcome = await fetchWithPolicy(url, timeoutMs, maxBytes);
        const { mimeType, charset } = parseContentType(outcome.headers['content-type'] ?? null);
        // bodyRead=false means the Content-Type declared non-text content.
        // A body that was read is text when the Content-Type said so, or (with
        // no Content-Type at all) when it does not look like binary data.
        const isText =
          outcome.bodyRead &&
          (outcome.bodyBytes.length === 0 || mimeType !== null || looksLikeText(outcome.bodyBytes));

        const result: Record<string, unknown> = {
          requestedUrl: outcome.requestedUrl,
          finalUrl: outcome.finalUrl,
          ...(outcome.redirectChain.length > 0 ? { redirectChain: outcome.redirectChain } : {}),
          status: outcome.status,
          statusText: outcome.statusText,
          headers: outcome.headers,
          contentType: mimeType,
          bodyKind: isText ? 'text' : 'binary',
        };

        if (isText) {
          result.downloadedBytes = outcome.bodyBytes.length;
          result.truncated = outcome.truncated;
          result.content = decodeBody(outcome.bodyBytes, charset);
        } else {
          const declaredLength = outcome.headers['content-length']
            ? Number(outcome.headers['content-length'])
            : NaN;
          result.sizeBytes = Number.isFinite(declaredLength) ? declaredLength : null;
          result.note =
            'Non-text content type: the response body was not returned (metadata-only policy for binary content). ' +
            (Number.isFinite(declaredLength)
              ? `Size: ${declaredLength} bytes (from Content-Length).`
              : 'Size unknown (no Content-Length header).');
        }

        // structuredContent: the result reaches the event log and the model
        // as structure, not a JSON string.
        return {
          content: [],
          structuredContent: result,
        };
      } catch (error) {
        const message =
          error instanceof WebFetchError
            ? `[${error.kind}] ${error.message}`
            : `[unexpected_error] ${error instanceof Error ? error.message : String(error)}`;

        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
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

export async function start(_ctx: { filesApi: unknown }) {
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

    const server = createMcpServer();
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
