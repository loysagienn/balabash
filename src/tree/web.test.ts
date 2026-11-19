// The node `web`, called the way every caller reaches it: through a grant
// and the one path of a call (src/catalog). The network is the test's own:
// names resolve by a table, and the one address that may be dialled besides
// the public internet is the loopback the test's server listens on — so the
// exchange is real (sockets, redirects, codings, broken connections), and
// nothing leaves the host. What the default network refuses is checked on
// the node of the tree itself, with calls that are refused before any
// connection.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { CapabilityError, buildCatalog, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { Catalog, ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import { internet, isPublicAddress } from './web-request.ts';
import type { Net } from './web-request.ts';

const NO_CONNECTIONS: ConnectionsPort = {
  accounts: async () => [],
  secretsReady: async () => false,
};

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let files: typeof import('../files/index.ts');
// The node over the test's network, and the node of the tree.
let grant: Grant;
let treeGrant: Grant;
let server: http.Server;
let garbage: net.Server;
let port: number;
let garbagePort: number;
// How many times each name was resolved.
const resolved = new Map<string, number>();

type Value = Record<string, any>;

const HOSTS: Record<string, string[]> = {
  'site.test': ['127.0.0.1'],
  'private.test': ['10.0.0.7'],
  'mixed.test': ['127.0.0.1', '192.168.1.1'],
  'empty.test': [],
};

const testNet: Net = {
  async resolve(hostname) {
    resolved.set(hostname, (resolved.get(hostname) ?? 0) + 1);

    if (hostname === 'flaky.test') {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN flaky.test'), { code: 'EAI_AGAIN' });
    }

    const addresses = HOSTS[hostname];

    if (!addresses) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }

    return addresses.map(address => ({ address, family: 4 }));
  },
  isPublic: address => address === '127.0.0.1' || internet.isPublic(address),
};

function grantOver(catalog: Catalog): Promise<Grant> {
  return computeGrant(
    catalog,
    { allows: () => true, actions: ['describe', 'call'] },
    { caller: { workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'tester' }, connections: NO_CONNECTIONS },
  );
}

function invoke(name: string, input: JsonObject, as: Grant = grant, signal?: AbortSignal): Promise<Value> {
  return invokeCapability(as, name, input, { connections: NO_CONNECTIONS, signal }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<CapabilityError> {
  let refusal: CapabilityError | null = null;

  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);
    refusal = error;

    return true;
  });

  return refusal!;
}

const site = (route: string) => `http://site.test:${port}${route}`;

const PDF = Buffer.from('%PDF-1.7\n\0\u0001\u0002 the bytes of a file\n');
const REPORT = 'отчёт';

// The test's server: one route per behaviour of a server.
function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://site.test');
  const route = url.pathname;
  const text = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    response.end(body);
  };
  const redirect = (location: string | null, status = 302) => {
    response.writeHead(status, location === null ? {} : { location });
    response.end();
  };

  if (route === '/json') {
    response.writeHead(200, [
      ['Content-Type', 'application/json; charset=utf-8'],
      ['X-Custom', 'A'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    response.end(JSON.stringify({ ok: true, agent: request.headers['user-agent'], encoding: request.headers['accept-encoding'] }));
  } else if (route === '/missing') {
    text(404, 'nothing here');
  } else if (route === '/failing') {
    text(503, 'try later');
  } else if (route.startsWith('/hops/')) {
    const left = Number(route.slice('/hops/'.length));

    if (left > 0) {
      redirect(`/hops/${left - 1}`, left % 2 ? 302 : 307);
    } else {
      text(200, 'landed');
    }
  } else if (route === '/to-file') {
    redirect('/files/report.pdf', 301);
  } else if (route === '/to-private') {
    redirect(`http://private.test:${port}/json`);
  } else if (route === '/to-literal') {
    redirect('http://169.254.169.254/latest/meta-data/');
  } else if (route === '/no-location') {
    redirect(null);
  } else if (route === '/to-ftp') {
    redirect('ftp://site.test/file');
  } else if (route === '/to-credentials') {
    redirect(`http://user:secret@site.test:${port}/json`);
  } else if (route === '/image') {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': 5 });
    response.end(Buffer.from([137, 80, 78, 71, 13]));
  } else if (route === '/long') {
    text(200, 'a'.repeat(5000));
  } else if (route === '/exact') {
    text(200, 'b'.repeat(1000));
  } else if (route === '/accents') {
    text(200, 'é'.repeat(1000));
  } else if (route === '/gzip') {
    text(200, zlib.gzipSync(JSON.stringify({ packed: 'x'.repeat(3000) })), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
  } else if (route === '/brotli') {
    text(200, zlib.brotliCompressSync('brotli says hello'), { 'content-encoding': 'br' });
  } else if (route === '/bad-gzip') {
    text(200, 'this is not gzip', { 'content-encoding': 'gzip' });
  } else if (route === '/empty-gzip') {
    text(200, '', { 'content-encoding': 'gzip' });
  } else if (route === '/odd-coding') {
    text(200, 'coded somehow', { 'content-encoding': 'x-odd', 'content-length': 13 });
  } else if (route === '/untyped-text') {
    response.writeHead(200);
    response.end('plain words');
  } else if (route === '/untyped-bytes') {
    response.writeHead(200, { 'content-length': 4 });
    response.end(Buffer.from([1, 0, 2, 3]));
  } else if (route === '/latin1') {
    text(200, Buffer.from([0x63, 0x61, 0x66, 0xe9]), { 'content-type': 'text/plain; charset=ISO-8859-1' });
  } else if (route === '/no-content') {
    response.writeHead(204);
    response.end();
  } else if (route === '/silent') {
    // Never answers.
  } else if (route === '/stalls') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('the beginning');
  } else if (route === '/drops') {
    request.socket.destroy();
  } else if (route === '/cut') {
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 1000 });
    response.write('only the beginning', () => request.socket.destroy());
  } else if (route === '/files/report.pdf') {
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
    response.end(PDF);
  } else if (route === '/named') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="fallback.bin"; filename*=UTF-8''${encodeURIComponent(`../${REPORT}.pdf`)}`,
    });
    response.end(PDF);
  } else if (route === '/') {
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
    response.end('a,b\n1,2\n');
  } else if (route === '/packed-file') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    response.end(zlib.gzipSync('c'.repeat(4000)));
  } else if (route === '/empty') {
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': 0 });
    response.end();
  } else if (route === '/big') {
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': 5000 });
    response.end(Buffer.alloc(5000, 7));
  } else if (route === '/big-chunked') {
    response.writeHead(200, { 'content-type': 'application/zip' });
    response.write(Buffer.alloc(2500, 7));
    response.end(Buffer.alloc(2500, 7));
  } else {
    text(404, 'no such route');
  }
}

function listen(listener: http.Server | net.Server): Promise<number> {
  return new Promise(resolve => {
    listener.listen(0, '127.0.0.1', () => resolve((listener.address() as AddressInfo).port));
  });
}

async function storedFiles(): Promise<number> {
  return prisma.file.count({ where: { workspaceId: stand.workspaceId } });
}

// What a download in flight keeps beside the storage.
async function leftovers(): Promise<string[]> {
  return fs.readdir(path.join(stand.dir, 'data', 'workspace', stand.workspaceId, 'tmp')).catch(() => []);
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  files = await import('../files/index.ts');

  const { webNode } = await import('./web.ts');
  const tree = await import('./index.ts');

  grant = await grantOver(buildCatalog({ summary: 'The web over the network of a test.', children: [webNode(testNet)] }).catalog);
  treeGrant = await grantOver(tree.catalog());

  server = http.createServer(serve);
  port = await listen(server);
  // Something that listens and does not speak HTTP.
  garbage = net.createServer(socket => {
    socket.on('error', () => {});
    socket.end('these are not the words of HTTP\r\n\r\n');
  });
  garbagePort = await listen(garbage);
});

after(async () => {
  server.closeAllConnections();
  server.close();
  garbage.close();
  await stand.stop();
});

describe('the addresses of the public internet', () => {
  test('private, loopback, link-local and other non-public addresses are told apart from public ones, in every notation', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
      '::',
      '::1',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '64:ff9b::7f00:1',
      '2001:db8::1',
      'not an address',
      '',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }

    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2a00:1450::200e']) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  test('the node of the tree refuses what is not public before any connection: a literal address in any notation, a name that resolves to one', async () => {
    for (const url of [
      'http://127.0.0.1:1/',
      'http://2130706433:1/',
      'http://0x7f.1:1/',
      'http://[::1]:1/',
      'http://[::ffff:127.0.0.1]:1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'https://[fe80::1]/',
    ]) {
      await refuses(invoke('web_get', { url }, treeGrant), 'invalid_input', /^The address \S+ is not a public address: only the public internet is reachable\.$/);
      await refuses(invoke('web_download', { url }, treeGrant), 'invalid_input', /is not a public address/);
    }

    // The name of this host, by the resolver of the host itself.
    await refuses(invoke('web_get', { url: 'http://localhost:1/' }, treeGrant), 'invalid_input', /^The host "localhost" resolves to (127\.0\.0\.1|::1), which is not a public address/);
  });

  test('a name is checked by the look-up of the connection itself — once per hop — and one address out of several that is not public refuses the name', async () => {
    resolved.clear();

    assert.equal((await invoke('web_get', { url: site('/hops/2') })).status, 200);
    assert.equal(resolved.get('site.test'), 3);

    await refuses(invoke('web_get', { url: `http://private.test:${port}/json` }), 'invalid_input', /^The host "private\.test" resolves to 10\.0\.0\.7, which is not a public address: only the public internet is reachable\.$/);
    await refuses(invoke('web_get', { url: `http://mixed.test:${port}/json` }), 'invalid_input', /"mixed\.test" resolves to 192\.168\.1\.1/);
    await refuses(invoke('web_download', { url: `http://private.test:${port}/files/report.pdf` }), 'invalid_input', /"private\.test" resolves to 10\.0\.0\.7/);
  });

  test('a redirect to an address that is not public is refused on the hop that leads there, and the refusal names the way', async () => {
    await refuses(
      invoke('web_get', { url: site('/to-private') }),
      'invalid_input',
      new RegExp(`"private\\.test" resolves to 10\\.0\\.0\\.7, which is not a public address.* It was reached through a redirect from http://site\\.test:${port}/to-private\\.$`),
    );
    await refuses(invoke('web_get', { url: site('/to-literal') }), 'invalid_input', /The address 169\.254\.169\.254 is not a public address.*through a redirect from/);
    await refuses(invoke('web_download', { url: site('/to-private') }), 'invalid_input', /through a redirect from/);
    assert.equal(await storedFiles(), 0);
  });
});

describe('the URL of a call', () => {
  test('is an absolute http(s) URL without credentials; a limit out of its range is refused by the type, not clamped', async () => {
    for (const [url, message] of [
      ['example.com/path', /is not an absolute URL/],
      ['/relative', /is not an absolute URL/],
      ['', /is not an absolute URL/],
      ['ftp://example.com/file', /Only http and https URLs are reachable, not "ftp:"/],
      ['file:///etc/passwd', /not "file:"/],
      ['http://user:secret@example.com/', /carries credentials/],
    ] as const) {
      await refuses(invoke('web_get', { url }), 'invalid_input', message);
      await refuses(invoke('web_download', { url }), 'invalid_input', message);
    }

    for (const input of [{ timeoutSeconds: 0 }, { timeoutSeconds: 121 }, { maxContentBytes: 999 }, { maxContentBytes: 1_000_001 }, { maxContentBytes: 1500.5 }] as JsonObject[]) {
      await refuses(invoke('web_get', { url: site('/json'), ...input }), 'invalid_input', /web_get/);
    }

    for (const input of [{ timeoutSeconds: 301 }, { maxFileBytes: 999 }, { maxFileBytes: 300_000_001 }] as JsonObject[]) {
      await refuses(invoke('web_download', { url: site('/files/report.pdf'), ...input }), 'invalid_input', /web_download/);
    }
  });

  test('a host that does not exist is not_found; a name that could not be resolved now is unavailable', async () => {
    await refuses(invoke('web_get', { url: 'http://nowhere.test/' }), 'not_found', /^The host "nowhere\.test" does not exist\.$/);
    await refuses(invoke('web_get', { url: 'http://empty.test/' }), 'not_found', /"empty\.test" does not exist/);
    await refuses(invoke('web_download', { url: 'http://nowhere.test/file.zip' }), 'not_found', /"nowhere\.test" does not exist/);
    await refuses(invoke('web_get', { url: 'http://flaky.test/' }), 'unavailable', /"flaky\.test" could not be resolved \(EAI_AGAIN\)/);
  });
});

describe('web_get', () => {
  test('returns the response as it is: every key of the value, headers by lower-case names with repeated ones joined', async () => {
    const value = await invoke('web_get', { url: site('/json') });
    const body = JSON.stringify({ ok: true, agent: 'Balabash/1.0', encoding: 'gzip, deflate, br' });

    assert.deepEqual(Object.keys(value), ['finalUrl', 'redirectChain', 'status', 'statusText', 'headers', 'contentType', 'bodyKind', 'content', 'downloadedBytes', 'truncated', 'sizeBytes']);
    assert.deepEqual(
      { ...value, headers: null },
      {
        finalUrl: site('/json'),
        redirectChain: [],
        status: 200,
        statusText: 'OK',
        headers: null,
        contentType: 'application/json',
        bodyKind: 'text',
        content: body,
        downloadedBytes: Buffer.byteLength(body),
        truncated: false,
        sizeBytes: null,
      },
    );
    assert.equal(value.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(value.headers['x-custom'], 'A');
    assert.equal(value.headers['set-cookie'], 'a=1\nb=2');
    assert.ok(Object.keys(value.headers).every(name => name === name.toLowerCase()));
  });

  test('any status is a result, 4xx and 5xx included', async () => {
    const missing = await invoke('web_get', { url: site('/missing') });
    const failing = await invoke('web_get', { url: site('/failing') });
    const empty = await invoke('web_get', { url: site('/no-content') });

    assert.deepEqual([missing.status, missing.statusText, missing.content], [404, 'Not Found', 'nothing here']);
    assert.deepEqual([failing.status, failing.content], [503, 'try later']);
    assert.deepEqual([empty.status, empty.bodyKind, empty.content, empty.downloadedBytes, empty.contentType], [204, 'text', '', 0, null]);
  });

  test('follows up to 5 redirects and gives the chain; a sixth, a redirect without a usable Location and one that leaves http are the failure of the server', async () => {
    const value = await invoke('web_get', { url: site('/hops/5') });

    assert.deepEqual([value.status, value.content, value.finalUrl], [200, 'landed', site('/hops/0')]);
    assert.deepEqual(
      value.redirectChain,
      [5, 4, 3, 2, 1].map(left => ({ url: site(`/hops/${left}`), status: left % 2 ? 302 : 307, location: site(`/hops/${left - 1}`) })),
    );

    await refuses(invoke('web_get', { url: site('/hops/6') }), 'external_error', /^More than 5 redirects: .*\/hops\/6 → .*\/hops\/1 → .*\/hops\/0\.$/);
    await refuses(invoke('web_get', { url: site('/no-location') }), 'external_error', /The redirect \(302\) from .*\/no-location carries no Location/);
    await refuses(invoke('web_get', { url: site('/to-ftp') }), 'external_error', /leaves http: it points to "ftp:"/);
    await refuses(invoke('web_get', { url: site('/to-credentials') }), 'external_error', /points to a URL with credentials/);
  });

  test('a text body is cut at the byte limit and says so; a body of exactly the limit is whole; a character is never cut in half', async () => {
    const long = await invoke('web_get', { url: site('/long'), maxContentBytes: 1000 });
    const exact = await invoke('web_get', { url: site('/exact'), maxContentBytes: 1000 });
    const accents = await invoke('web_get', { url: site('/accents'), maxContentBytes: 1001 });

    assert.deepEqual([long.content, long.downloadedBytes, long.truncated], ['a'.repeat(1000), 1000, true]);
    assert.deepEqual([exact.content.length, exact.downloadedBytes, exact.truncated], [1000, 1000, false]);
    // 1001 bytes end inside the 501st two-byte character.
    assert.deepEqual([accents.content, accents.downloadedBytes, accents.truncated], ['é'.repeat(500), 1001, true]);
  });

  test('a binary body is not downloaded: only its metadata comes back', async () => {
    const image = await invoke('web_get', { url: site('/image') });
    const pdf = await invoke('web_get', { url: site('/files/report.pdf') });

    assert.deepEqual(
      [image.status, image.contentType, image.bodyKind, image.content, image.downloadedBytes, image.truncated, image.sizeBytes],
      [200, 'image/png', 'binary', null, null, false, 5],
    );
    assert.deepEqual([pdf.bodyKind, pdf.content, pdf.sizeBytes], ['binary', null, PDF.length]);
  });

  test('a body without a declared type is text unless its beginning holds a NUL; the charset the server names is the one the text is read in', async () => {
    const words = await invoke('web_get', { url: site('/untyped-text') });
    const bytes = await invoke('web_get', { url: site('/untyped-bytes') });
    const latin = await invoke('web_get', { url: site('/latin1') });

    assert.deepEqual([words.contentType, words.bodyKind, words.content, words.downloadedBytes], [null, 'text', 'plain words', 11]);
    assert.deepEqual([bytes.contentType, bytes.bodyKind, bytes.content, bytes.downloadedBytes, bytes.sizeBytes], [null, 'binary', null, null, 4]);
    assert.deepEqual([latin.content, latin.downloadedBytes], ['café', 4]);
  });

  test('a content coding is taken off: the limit and the count are of the content; a coding nobody knows leaves a body that is not for reading', async () => {
    const packed = JSON.stringify({ packed: 'x'.repeat(3000) });
    const gzip = await invoke('web_get', { url: site('/gzip') });
    const cut = await invoke('web_get', { url: site('/gzip'), maxContentBytes: 1000 });
    const brotli = await invoke('web_get', { url: site('/brotli') });
    const nothing = await invoke('web_get', { url: site('/empty-gzip') });
    const odd = await invoke('web_get', { url: site('/odd-coding') });

    assert.deepEqual([gzip.content, gzip.downloadedBytes, gzip.truncated, gzip.headers['content-encoding']], [packed, packed.length, false, 'gzip']);
    assert.deepEqual([cut.content, cut.downloadedBytes, cut.truncated], [packed.slice(0, 1000), 1000, true]);
    assert.equal(brotli.content, 'brotli says hello');
    assert.deepEqual([nothing.bodyKind, nothing.content, nothing.downloadedBytes], ['text', '', 0]);
    assert.deepEqual([odd.bodyKind, odd.content, odd.sizeBytes, odd.headers['content-encoding']], ['binary', null, 13, 'x-odd']);

    await refuses(invoke('web_get', { url: site('/bad-gzip') }), 'external_error', /The body site\.test:\d+ sent is not valid "gzip" content/);
  });

  test('no answer is unavailable: the time is for the whole request — the headers and the body — and a dropped connection is not a response', async () => {
    const started = Date.now();

    await refuses(invoke('web_get', { url: site('/silent'), timeoutSeconds: 1 }), 'unavailable', /^No complete response within 1 seconds: the request was dropped\.$/);
    await refuses(invoke('web_get', { url: site('/stalls'), timeoutSeconds: 1 }), 'unavailable', /No complete response within 1 seconds/);
    assert.ok(Date.now() - started < 10_000);

    await refuses(invoke('web_get', { url: site('/drops') }), 'unavailable', /^No response from site\.test:\d+: /);
    // Nothing listens there.
    garbage.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    await refuses(invoke('web_get', { url: `http://site.test:${garbagePort}/` }), 'unavailable', /No response from site\.test:\d+: ECONNREFUSED/);
    garbagePort = await listen(garbage);
  });

  test('a call that is cancelled drops the request', async () => {
    const cancelling = new AbortController();
    const call = invoke('web_get', { url: site('/silent') }, grant, cancelling.signal);

    setTimeout(() => cancelling.abort(), 100);
    await refuses(call, 'unavailable', /^The call was cancelled before the response was complete\.$/);
  });

  test('a server that breaks the exchange — no TLS where https was asked, an answer that is not HTTP — is an external error', async () => {
    await refuses(invoke('web_get', { url: `https://site.test:${port}/json` }), 'external_error', /^The TLS exchange with site\.test:\d+ failed: /);
    await refuses(invoke('web_get', { url: `http://site.test:${garbagePort}/` }), 'external_error', /answered with something that is not an HTTP response: HPE_/);
  });
});

describe('web_download', () => {
  test('stores the file and gives its reference: the name of the URL that answered, the type the server names, the bytes as they are', async () => {
    const before = await storedFiles();
    const ref = await invoke('web_download', { url: site('/to-file') });

    assert.deepEqual(ref, { kind: 'file', id: ref.id, name: 'report.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, width: null, height: null });
    assert.deepEqual(Buffer.from(await new Response(await files.openFileContent(ref.id)).arrayBuffer()), PDF);
    assert.equal(await storedFiles(), before + 1);
    assert.equal((await prisma.file.findUniqueOrThrow({ where: { id: ref.id } })).workspaceId, stand.workspaceId);
    assert.deepEqual(await leftovers(), []);
  });

  test('the name the server gives the file wins, as a plain filename; without any name the file is called by its type; a coding the server applied is taken off', async () => {
    const named = await invoke('web_download', { url: site('/named') });
    const bare = await invoke('web_download', { url: `http://site.test:${port}` });
    const packed = await invoke('web_download', { url: site('/packed-file') });

    assert.deepEqual([named.name, named.contentType, named.sizeBytes], [`${REPORT}.pdf`, 'application/octet-stream', PDF.length]);
    assert.deepEqual([bare.name, bare.contentType, bare.sizeBytes], ['download.csv', 'text/csv', 8]);
    assert.deepEqual([packed.name, packed.contentType, packed.sizeBytes], ['packed-file', 'text/plain', 4000]);
    assert.equal(await new Response(await files.openFileContent(packed.id)).text(), 'c'.repeat(4000));
  });

  test('fails as a whole and stores nothing: a status that is not 2xx, an empty body, a file over the limit — declared or found on the way — a body cut off, no answer in time', async () => {
    const before = await storedFiles();
    const missing = await refuses(invoke('web_download', { url: site('/missing') }), 'external_error', /\/missing answered 404 Not Found: nothing was stored\.$/);

    assert.deepEqual(missing.details, { status: 404, statusText: 'Not Found', finalUrl: site('/missing') });
    await refuses(invoke('web_download', { url: site('/failing') }), 'external_error', /answered 503/);
    await refuses(invoke('web_download', { url: site('/empty') }), 'external_error', /answered with an empty body: nothing was stored/);
    await refuses(invoke('web_download', { url: site('/no-content') }), 'external_error', /answered with an empty body/);
    await refuses(invoke('web_download', { url: site('/big'), maxFileBytes: 1000 }), 'invalid_input', /^The file is 5000 bytes, over the limit of 1000 bytes: nothing was stored\./);
    await refuses(invoke('web_download', { url: site('/big-chunked'), maxFileBytes: 4000 }), 'invalid_input', /^The file is larger than the limit of 4000 bytes: nothing was stored\./);
    await refuses(invoke('web_download', { url: site('/packed-file'), maxFileBytes: 1000 }), 'invalid_input', /larger than the limit of 1000 bytes/);
    await refuses(invoke('web_download', { url: site('/cut') }), 'unavailable', /The connection to site\.test:\d+ failed before the body was complete/);
    await refuses(invoke('web_download', { url: site('/stalls'), timeoutSeconds: 1 }), 'unavailable', /No complete response within 1 seconds/);
    await refuses(invoke('web_download', { url: site('/hops/6') }), 'external_error', /More than 5 redirects/);
    await refuses(invoke('web_download', { url: site('/odd-coding') }), 'external_error', /content coding "x-odd"/);

    assert.equal(await storedFiles(), before);
    assert.deepEqual(await leftovers(), []);

    // The file of exactly the limit is taken.
    assert.equal((await invoke('web_download', { url: site('/big'), maxFileBytes: 5000 })).sizeBytes, 5000);
  });
});
