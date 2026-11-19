// A GET to the public internet, the way the node `web` makes it: one
// exchange per hop, redirects followed by hand, and every address checked
// at the moment the connection is made. The check is not a look-up before
// the request — a name could answer one address to the check and another to
// the connection — it is the look-up of the connection itself: the socket
// dials only an address this module has seen and found public.
//
// What is refused: private, loopback, link-local and other addresses that
// are not of the public internet, on the first hop and on every redirect.
// What the module does not do is read the body: it hands the answer over
// with its headers, and the bytes come as the caller asks for them.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { CapabilityError } from '../catalog/index.ts';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'Balabash/1.0';

// ---------------------------------------------------------------------------
// The addresses that are not of the public internet.

// IPv4: every address is of the public internet except the special-purpose
// blocks (the IANA IPv4 special-purpose registry) nobody reaches globally.
const specialV4 = new BlockList();

specialV4.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
specialV4.addSubnet('10.0.0.0', 8, 'ipv4'); // private
specialV4.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
specialV4.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
specialV4.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local (cloud metadata)
specialV4.addSubnet('172.16.0.0', 12, 'ipv4'); // private
specialV4.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
specialV4.addSubnet('192.0.2.0', 24, 'ipv4'); // documentation
specialV4.addSubnet('192.88.99.0', 24, 'ipv4'); // the 6to4 relay anycast, deprecated
specialV4.addSubnet('192.168.0.0', 16, 'ipv4'); // private
specialV4.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
specialV4.addSubnet('198.51.100.0', 24, 'ipv4'); // documentation
specialV4.addSubnet('203.0.113.0', 24, 'ipv4'); // documentation
specialV4.addSubnet('224.0.0.0', 3, 'ipv4'); // multicast, reserved, broadcast

// IPv6 the other way round: the public internet is the global unicast space
// 2000::/3 and nothing else — whatever lies outside it (loopback, NAT64,
// unique local, link-local, multicast, a block assigned tomorrow) is not
// public without being listed — less the special-purpose blocks inside it
// (the IANA IPv6 special-purpose registry).
const globalUnicastV6 = new BlockList();

globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

const specialV6 = new BlockList();

// IETF protocol assignments, the whole block: Teredo, benchmarking, ORCHID.
// The few anycast services inside it are not where a GET goes.
specialV6.addSubnet('2001::', 23, 'ipv6');
specialV6.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
specialV6.addSubnet('2002::', 16, 'ipv6'); // 6to4
specialV6.addSubnet('3fff::', 20, 'ipv6'); // documentation

// An IPv4-mapped address (::ffff:a.b.c.d, in any notation) is the IPv4
// address it carries: BlockList checks it against the IPv4 subnets.
const mappedV4 = new BlockList();

mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6');

export function isPublicAddress(raw: string): boolean {
  // Without the zone of a link-local address ("fe80::1%eth0").
  const address = raw.split('%')[0] ?? '';

  switch (isIP(address)) {
    case 4:
      return !specialV4.check(address, 'ipv4');
    case 6:
      return mappedV4.check(address, 'ipv6')
        ? !specialV4.check(address, 'ipv6')
        : globalUnicastV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
    default:
      // What is not an address is not a public one.
      return false;
  }
}

export type ResolvedAddress = { address: string; family: number };

// The network as the request sees it: the addresses of a name, and which
// addresses may be dialled.
export type Net = {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  isPublic(address: string): boolean;
};

export const internet: Net = {
  resolve: hostname => dns.lookup(hostname, { all: true }),
  isPublic: isPublicAddress,
};

// ---------------------------------------------------------------------------
// The time of a call: one limit for the whole exchange — every hop and the
// body — and the cancellation of whoever made the call.

export type CallTime = {
  signal: AbortSignal;
  // Whether the signal fired because the time ran out, not by cancellation.
  expired(): boolean;
  // Why the signal fired, as the outcome of an exchange it cut.
  ended(): CapabilityError;
};

export function callTime(timeoutSeconds: number, cancelled: AbortSignal | null): CallTime {
  const timeout = AbortSignal.timeout(Math.round(timeoutSeconds * 1000));

  return {
    signal: cancelled ? AbortSignal.any([timeout, cancelled]) : timeout,
    expired: () => timeout.aborted,
    ended: () =>
      timeout.aborted
        ? new CapabilityError('unavailable', `No complete response within ${timeoutSeconds} seconds: the request was dropped.`)
        : new CapabilityError('unavailable', 'The call was cancelled before the response was complete.'),
  };
}

// ---------------------------------------------------------------------------
// The URL of a call and of a redirect.

function targetUrl(raw: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new CapabilityError('invalid_input', `"${raw}" is not an absolute URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CapabilityError('invalid_input', `Only http and https URLs are reachable, not "${url.protocol}".`);
  }

  if (url.username || url.password) {
    throw new CapabilityError('invalid_input', 'The URL carries credentials (user:password@host): pass it without them.');
  }

  return url;
}

function hostOf(url: URL): string {
  // An IPv6 address stands in brackets in a URL.
  return url.hostname.replace(/^\[|\]$/g, '');
}

function refusedAddress(url: URL, address: string, via: string | null): CapabilityError {
  const host = hostOf(url);
  const what = host === address ? `The address ${address}` : `The host "${host}" resolves to ${address}, which`;
  const how = via ? ` It was reached through a redirect from ${via}.` : '';

  return new CapabilityError('invalid_input', `${what} is not a public address: only the public internet is reachable.${how}`);
}

// Where a redirect leads. A redirect that cannot be followed is the
// server's failure, not the caller's.
function redirectTarget(response: http.IncomingMessage, from: URL): URL {
  const location = response.headers.location;

  if (!location) {
    throw new CapabilityError('external_error', `The redirect (${response.statusCode}) from ${from.href} carries no Location.`);
  }

  let next: URL;

  try {
    next = new URL(location, from);
  } catch {
    throw new CapabilityError('external_error', `The redirect from ${from.href} points to "${location}", which is not a URL.`);
  }

  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new CapabilityError('external_error', `The redirect from ${from.href} leaves http: it points to "${next.protocol}".`);
  }

  if (next.username || next.password) {
    throw new CapabilityError('external_error', `The redirect from ${from.href} points to a URL with credentials.`);
  }

  return next;
}

// ---------------------------------------------------------------------------
// One hop.

// The look-up of the connection: the addresses of the name, every one of
// them public, or a refusal — the socket gets nothing else to dial.
function guardedLookup(net: Net, url: URL, via: string | null): LookupFunction {
  return (hostname, options, callback) => {
    const done = callback as (error: Error | null, address?: string | ResolvedAddress[], family?: number) => void;

    net.resolve(hostname).then(
      addresses => {
        const refused = addresses.find(({ address }) => !net.isPublic(address));
        const first = addresses[0];

        if (refused) {
          done(refusedAddress(url, refused.address, via));
        } else if (!first) {
          done(new CapabilityError('not_found', `The host "${hostname}" does not exist.`));
        } else if (options.all) {
          done(null, addresses);
        } else {
          done(null, first.address, first.family);
        }
      },
      (error: NodeJS.ErrnoException) => {
        done(
          error.code === 'ENOTFOUND'
            ? new CapabilityError('not_found', `The host "${hostname}" does not exist.`)
            : new CapabilityError('unavailable', `The name "${hostname}" could not be resolved (${error.code ?? error.message}).`),
        );
      },
    );
  };
}

const TLS_FAILURE = /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO$)/;

// A failure of the exchange with one host, as the outcome of the call: the
// server broke the exchange (TLS, a response that is not HTTP), or there
// was no answer.
function exchangeFailure(error: unknown, url: URL, time: CallTime): CapabilityError {
  if (error instanceof CapabilityError) {
    return error;
  }

  if (time.signal.aborted) {
    return time.ended();
  }

  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  const detail = code || (error instanceof Error && error.message) || String(error);

  if (TLS_FAILURE.test(code)) {
    return new CapabilityError('external_error', `The TLS exchange with ${url.host} failed: ${detail}.`);
  }

  if (code.startsWith('HPE_')) {
    return new CapabilityError('external_error', `${url.host} answered with something that is not an HTTP response: ${detail}.`);
  }

  return new CapabilityError('unavailable', `No response from ${url.host}: ${detail}.`);
}

function send(
  url: URL,
  { net, time, acceptEncoding, via }: { net: Net; time: CallTime; acceptEncoding: string; via: string | null },
): Promise<http.IncomingMessage> {
  const host = hostOf(url);

  // A literal address is dialled without a look-up, so it is checked here.
  if (isIP(host) && !net.isPublic(host)) {
    throw refusedAddress(url, host, via);
  }

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET',
      // A connection of its own: nothing pooled, so the look-up above runs
      // for every hop.
      agent: false,
      signal: time.signal,
      lookup: guardedLookup(net, url, via),
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': acceptEncoding },
    });

    // Stays for the life of the request: a failure after the response has
    // come is the body's to report, and must not go unheard here.
    request.on('error', error => reject(exchangeFailure(error, url, time)));
    request.once('response', response => {
      response.on('error', () => {});
      resolve(response);
    });
    // A server that switches protocols instead of answering: the request
    // ends with neither a response nor an error.
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      reject(
        new CapabilityError('external_error', `${url.host} answered the GET by switching protocols (${response.statusCode}), not with a response.`),
      );
    });
    // Whatever closes the request before a response ends the wait: every
    // exchange has an outcome, with or without an event that names it.
    request.once('close', () => reject(exchangeFailure(new Error('the connection closed without a response'), url, time)));
    request.end();
  });
}

// ---------------------------------------------------------------------------
// The answer.

export type RedirectHop = { url: string; status: number; location: string };

export type WebAnswer = {
  // The URL that answered, after redirects.
  finalUrl: URL;
  redirectChain: RedirectHop[];
  status: number;
  statusText: string;
  // Names in lower case; the values of a repeated header joined.
  headers: Record<string, string>;
  // The content coding of the body when this side cannot take it off; null
  // when the bytes of `chunks` are the content itself.
  coding: string | null;
  // The bytes of the body as they arrive, the content coding taken off. A
  // consumer that has enough stops reading; a failure on the way is a
  // CapabilityError.
  chunks(): AsyncGenerator<Buffer>;
  // Lets the connection go. Every answer is closed by whoever opened it.
  close(): void;
};

function headersOf(response: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join('\n') : value;
    }
  }

  return headers;
}

// The content codings this side takes off.
const DECODED_CODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);

const ZSTD_WINDOW_LOG_MAX = 23;

function decoderOf(coding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | zlib.ZstdDecompress | null {
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd':
      // The window of a frame is memory the decoder holds whatever the
      // limit on its output: 8 MB is what a content coding may ask for
      // (RFC 9659), a frame that asks for more is refused.
      return zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX } });
    default:
      return null;
  }
}

async function* bodyChunks(response: http.IncomingMessage, coding: string, url: URL, time: CallTime): AsyncGenerator<Buffer> {
  const decoder = decoderOf(coding);
  // The connection and the decoder end together: a failure of the
  // connection — one that came before the first byte was asked for too —
  // reaches the decoder, and with it the reader.
  const body = decoder ? pipeline(response, decoder, () => {}) : response;

  try {
    for await (const chunk of body) {
      yield chunk as Buffer;
    }
  } catch (error) {
    if (time.signal.aborted) {
      throw time.ended();
    }

    const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
    const message = error instanceof Error ? error.message : String(error);

    if (decoder && /^(Z_|ZSTD_|ERR_BROTLI|ERR_ZSTD|ERR_ZLIB)/.test(code)) {
      // A body without a single byte carries no coded stream to end badly.
      if (code === 'Z_BUF_ERROR' && decoder.bytesWritten === 0) {
        return;
      }

      throw new CapabilityError('external_error', `The body ${url.host} sent is not valid "${coding}" content: ${message}.`);
    }

    throw new CapabilityError('unavailable', `The connection to ${url.host} failed before the body was complete: ${code || message}.`);
  } finally {
    decoder?.destroy();
    response.destroy();
  }
}

// GET a public URL and follow its redirects to the response that answers.
// The body is not read here.
export async function openPublicUrl(
  rawUrl: string,
  { net, time, acceptEncoding }: { net: Net; time: CallTime; acceptEncoding: string },
): Promise<WebAnswer> {
  const redirectChain: RedirectHop[] = [];
  let url = targetUrl(rawUrl);

  for (;;) {
    const via = redirectChain.at(-1)?.url ?? null;
    const response = await send(url, { net, time, acceptEncoding, via });
    const status = response.statusCode ?? 0;

    if (!REDIRECT_STATUSES.has(status)) {
      const answered = url;
      const coding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase() || 'identity';
      const plain = coding === 'identity' || DECODED_CODINGS.has(coding);

      return {
        finalUrl: answered,
        redirectChain,
        status,
        statusText: response.statusMessage ?? '',
        headers: headersOf(response),
        coding: plain ? null : coding,
        chunks: () => bodyChunks(response, coding, answered, time),
        close: () => response.destroy(),
      };
    }

    response.destroy();

    const next = redirectTarget(response, url);

    redirectChain.push({ url: url.href, status, location: next.href });

    if (redirectChain.length > MAX_REDIRECTS) {
      throw new CapabilityError(
        'external_error',
        `More than ${MAX_REDIRECTS} redirects: ${redirectChain.map(hop => hop.url).join(' → ')} → ${next.href}.`,
      );
    }

    url = next;
  }
}
