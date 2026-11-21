// The node `drive` over the stand's database, called the way every caller
// reaches it: through a grant and the one path of a call (src/catalog), on
// the connections port of the tree. The outside is local: an authorization
// server that renews tokens and a server that answers as the Drive API
// does — its lists, its exports, and the sessions of its uploads with their
// 308 "go on". No consent page is walked: an account is a row the way the
// callback left it.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { CapabilityError, buildCatalog, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { Catalog, ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { closeServer, listen, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let files: typeof import('../files/index.ts');
let catalog: Catalog;
let port: ConnectionsPort;
let outside: http.Server;
let origin: string;

type Value = Record<string, any>;

const caller = () => ({ workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'engineer' });

function grantNow(): Promise<Grant> {
  return computeGrant(catalog, { allows: () => true, actions: ['describe', 'call'] }, { caller: caller(), connections: port });
}

async function invoke(name: string, input: JsonObject = {}, signal?: AbortSignal): Promise<Value> {
  return invokeCapability(await grantNow(), name, input, { connections: port, signal }) as Promise<Value>;
}

// A call of the node as the account `default`.
const drive = (name: string, input: JsonObject = {}, signal?: AbortSignal) =>
  invoke(`drive_${name}`, { account: 'default', ...input }, signal);

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

const aged = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

// An account as the OAuth callback leaves it: connected, with its tokens.
async function account(accountKey: string, tokens: Value, row: Value = {}): Promise<void> {
  const data = {
    status: 'connected',
    displayName: accountKey,
    threadId: stand.mainThreadId,
    tokens: { token_type: 'Bearer', expires_in: 3600, obtained_at: new Date().toISOString(), ...tokens },
    ...row,
  };

  await prisma.connection.upsert({
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: 'drive', accountKey } },
    create: { workspaceId: stand.workspaceId, server: 'drive', accountKey, ...data },
    update: data,
  });
}

async function rowOf(accountKey: string) {
  return prisma.connection.findUnique({
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: 'drive', accountKey } },
  });
}

// A file of the stand's storage, for an upload to read.
async function stored(name: string, contentType: string | null, body: Buffer): Promise<string> {
  return (await files.ingestFile({ body, workspaceId: stand.workspaceId, originalFilename: name, contentType, sizeBytes: body.length, scope: 'test' })).id;
}

const storedBytes = async (fileId: string) => Buffer.from(await new Response(await files.openFileContent(fileId)).arrayBuffer());

// ---------------------------------------------------------------------------
// The outside: the authorization server and the Drive API

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const DRAWING = 'application/vnd.google-apps.drawing';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The size of one piece of an upload, as the node cuts it.
const PIECE = 32 * 256 * 1024;

const PDF = Buffer.from('%PDF-1.7 the bytes of a report');
// A text one character longer than what a read returns, the cut falling
// inside a character of two code units.
const LONG_TEXT = `${'x'.repeat(19_999)}😀 the end`;

// A file as Drive keeps it: its resource, its bytes, what it exports to.
type Entry = { file: Value; content?: Buffer; exports?: Record<string, Buffer> };

type Session = { target: string | null; metadata: Value; type: string; declared: string | undefined; bytes: Buffer; made: Value | null };

const outsideState = {
  // The access tokens the API lets in, and whose Drive each opens.
  valid: new Map<string, string>([['access-1', 'me@example.com']]),
  refreshes: [] as string[],
  api: [] as Array<{ method: string; url: string; authorization: string | undefined; body: Value | null; headers: Record<string, string | undefined>; status: number }>,
  // How the API answers instead of its own way: a status, a 403 for too
  // many requests ('limit') or for an API that is not enabled ('setup'),
  // or no answer.
  broken: null as null | ((path: string, method: string) => number | 'limit' | 'setup' | 'drop' | 'hang' | null),
  // Called with every request before it is looked at.
  seen: null as null | ((path: string, method: string, token: string) => void),
  entries: new Map<string, Entry>(),
  drives: [
    { id: 'sd1', name: 'Team', createdTime: '2026-01-05T09:00:00.000Z' },
    { id: 'sd2', name: 'Archive' },
  ] as Value[],
  // Whether a list comes incomplete: when it looks through every shared
  // drive ('everything'), as Drive does it, or whatever it looks through.
  incomplete: false as false | 'everything' | 'always',
  sessions: new Map<string, Session>(),
  // The address a session is opened at, when not the stand's own.
  location: null as string | null,
  // What happens to the next pieces sent to a session, one entry a piece:
  // 'piece' — it is lost on the way, 'answer' — it is kept and the answer
  // is lost, 'cut' — it is kept and the answer breaks off inside its body,
  // 'busy' — Drive fails with a 503 and keeps nothing, 'kept-busy' — it
  // keeps the piece and fails with a 503, a number — only so many of its
  // bytes are kept, 'kept' — nothing: the piece is taken as it is.
  pieces: [] as Array<'kept' | 'piece' | 'answer' | 'cut' | 'busy' | 'kept-busy' | number>,
};

function entry(id: string, name: string, mimeType: string, more: Value = {}, body: { content?: Buffer; exports?: Record<string, Buffer> } = {}): void {
  outsideState.entries.set(id, {
    file: {
      id,
      name,
      mimeType,
      parents: ['my-root'],
      createdTime: '2026-10-01T08:00:00.000Z',
      modifiedTime: '2026-11-01T10:00:00.000Z',
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
      capabilities: { canEdit: true },
      trashed: false,
      ...(body.content ? { size: String(body.content.length) } : {}),
      ...more,
    },
    ...body,
  });
}

function seed(): void {
  entry('f-reports', 'Reports', FOLDER);
  entry('f-empty', 'Empty', FOLDER);
  entry("o'hara", "O'Hara", FOLDER);
  entry('pdf1', 'report.pdf', 'application/pdf', {
    parents: ['f-reports'],
    owners: [{ displayName: 'Anna', emailAddress: 'anna@example.com' }],
    lastModifyingUser: { emailAddress: 'me@example.com' },
    description: 'The final report',
  }, { content: PDF });
  entry('doc1', 'Plan', DOC, { parents: ['f-reports'] }, { exports: { 'text/markdown': Buffer.from(LONG_TEXT), [DOCX]: Buffer.from('docx bytes'), 'application/pdf': Buffer.from('pdf of the plan') } });
  entry('sheet1', 'Budget.xlsx', SHEET, { parents: ['f-reports'] }, { exports: { 'text/csv': Buffer.from('a,b\n1,2\n'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': Buffer.from('xlsx bytes') } });
  entry('slides1', 'Deck', SLIDES, {}, { exports: { 'text/plain': Buffer.from('Slide one\nSlide two') } });
  entry('drawing1', 'Sketch', DRAWING, {}, { exports: { 'image/png': Buffer.from('png bytes') } });
  entry('form1', 'Survey', 'application/vnd.google-apps.form');
  entry('txt1', 'notes.txt', 'text/plain', {}, { content: Buffer.from('plain notes — заметки') });
  entry('big-text', 'log.txt', 'text/plain', { size: '2000001' });
  entry('huge', 'backup.zip', 'application/zip', { size: '300000001' });
  entry('heavy-doc', 'Encyclopedia', DOC);
  entry('sc1', 'report (shortcut)', SHORTCUT, { shortcutDetails: { targetId: 'pdf1', targetMimeType: 'application/pdf' } });
  entry('sc-gone', 'lost (shortcut)', SHORTCUT, { shortcutDetails: { targetId: 'nowhere', targetMimeType: 'text/plain' } });
  entry('sc-folder', 'Reports (shortcut)', SHORTCUT, { shortcutDetails: { targetId: 'f-reports', targetMimeType: FOLDER } });
  entry('locked', 'contract.txt', 'text/plain', { capabilities: { canEdit: false } }, { content: Buffer.from('signed') });
  entry('guarded', 'ledger.txt', 'text/plain', {}, { content: Buffer.from('1 2 3') });
  entry('binned', 'old report.pdf', 'application/pdf', { parents: ['f-reports'], trashed: true }, { content: PDF });
  // A shared drive is a folder under its own id.
  entry('sd1', 'Team', FOLDER, { parents: undefined, driveId: 'sd1' });
  entry('sd-file', 'team report.txt', 'text/plain', { parents: ['sd1'], driveId: 'sd1' }, { content: Buffer.from('team') });
}

async function bytesOf(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function json(response: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

// A refusal as Drive words it: its status, its text, its machine reason and
// — for a parameter it does not take — the name of the parameter.
const refusal = (response: http.ServerResponse, code: number, text: string, reason: string, location?: string) =>
  json(response, code, {
    error: { code, message: text, errors: [{ message: text, domain: 'global', reason, ...(location ? { locationType: 'parameter', location } : {}) }] },
  });

const noFile = (response: http.ServerResponse, id: string) => refusal(response, 404, `File not found: ${id}.`, 'notFound', 'fileId');

function listFiles(response: http.ServerResponse, params: URLSearchParams): void {
  const q = params.get('q') ?? '';
  const driveId = params.get('driveId');
  const token = params.get('pageToken');
  const offset = token === null ? 0 : /^o\d+$/.test(token) ? Number(token.slice(1)) : -1;
  let found = [...outsideState.entries.values()].map(item => item.file);

  if (driveId !== null && !outsideState.drives.some(known => known.id === driveId)) {
    return refusal(response, 404, `Shared drive not found: ${driveId}`, 'notFound', 'driveId');
  }

  if (/syntax error/.test(q)) {
    return refusal(response, 400, 'Invalid Value', 'invalid', 'q');
  }

  if (params.get('orderBy') === 'bogus') {
    return refusal(response, 400, 'Invalid Value', 'invalid', 'orderBy');
  }

  if (offset < 0) {
    return refusal(response, 400, 'Invalid Value', 'invalid', 'pageToken');
  }

  const children = /^'((?:[^'\\]|\\.)*)' in parents and trashed = false$/.exec(q);
  const named = /^name contains '(.*)'$/.exec(q);

  if (children) {
    const parent = children[1].replace(/\\(.)/g, '$1');

    if (parent !== 'root' && !outsideState.entries.has(parent)) {
      return refusal(response, 404, 'File not found: .', 'notFound', 'fileId');
    }

    found = found
      .filter(file => file.parents?.[0] === (parent === 'root' ? 'my-root' : parent) && !file.trashed)
      .sort((a, b) => Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) || a.name.localeCompare(b.name));
  } else if (named) {
    found = found.filter(file => file.name.includes(named[1]));
  }

  if (driveId !== null) {
    found = found.filter(file => file.driveId === driveId);
  }

  const size = Number(params.get('pageSize'));

  json(response, 200, {
    files: found.slice(offset, offset + size),
    incompleteSearch: outsideState.incomplete === 'always' || (outsideState.incomplete === 'everything' && params.get('corpora') === 'allDrives'),
    ...(found.length > offset + size ? { nextPageToken: `o${offset + size}` } : {}),
  });
}

// The file a finished session made: a new one, or the new content of the
// one it was opened for.
function finish(session: Session, n: string): Value {
  if (session.target === null) {
    const id = `up${n}`;

    entry(id, session.metadata.name, session.metadata.mimeType ?? session.type.split(';')[0], { parents: session.metadata.parents ?? ['my-root'] }, { content: session.bytes });
    session.made = outsideState.entries.get(id)!.file;
  } else {
    const kept = outsideState.entries.get(session.target)!;

    kept.content = session.bytes;
    kept.file = { ...kept.file, ...(kept.file.mimeType.startsWith('application/vnd.google-apps.') ? {} : { size: String(session.bytes.length) }), imported: session.type };
    session.made = kept.file;
  }

  return session.made;
}

function serveSession(request: http.IncomingMessage, response: http.ServerResponse, n: string, body: Buffer): void {
  const session = outsideState.sessions.get(n);
  const sent = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(request.headers['content-range'] ?? '');
  const asked = /^bytes \*\/(\d+|\*)$/.exec(request.headers['content-range'] ?? '');

  if (!session || (!sent && !asked)) {
    return refusal(response, 400, 'Invalid request.', 'badRequest');
  }

  if (session.made) {
    return json(response, 200, session.made);
  }

  if (sent) {
    const fate = outsideState.pieces.shift() ?? 'kept';

    if (fate === 'piece') {
      request.socket.destroy();

      return;
    }

    if (fate === 'busy') {
      return refusal(response, 503, 'Backend Error', 'backendError');
    }

    if (Number(sent[1]) !== session.bytes.length || Number(sent[2]) - Number(sent[1]) + 1 !== body.length) {
      return refusal(response, 400, `Invalid request. The session holds ${session.bytes.length} bytes.`, 'badRequest');
    }

    session.bytes = Buffer.concat([session.bytes, typeof fate === 'number' ? body.subarray(0, fate) : body]);

    if (fate === 'answer' || fate === 'cut' || fate === 'kept-busy') {
      if ((sent[3] !== '*' && session.bytes.length === Number(sent[3]))) {
        finish(session, n);
      }

      if (fate === 'kept-busy') {
        return refusal(response, 503, 'Backend Error', 'backendError');
      }

      if (fate === 'cut') {
        // The head says a body follows, and the connection ends inside it.
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        response.write('{"id": "u', () => request.socket.destroy());

        return;
      }

      request.socket.destroy();

      return;
    }
  }

  const total = (sent ?? asked)![sent ? 3 : 1];

  if (total !== '*' && session.bytes.length === Number(total)) {
    return json(response, session.target === null ? 201 : 200, finish(session, n));
  }

  response.writeHead(308, session.bytes.length ? { range: `bytes=0-${session.bytes.length - 1}` } : {});
  response.end();
}

async function serveDrive(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const body = await bytesOf(request);
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
  const { entries } = outsideState;
  const logged = {
    method,
    url: `${path}${url.search}`,
    authorization: request.headers.authorization,
    body: request.headers['content-type']?.startsWith('application/json') && body.length ? (JSON.parse(body.toString('utf8')) as Value) : null,
    headers: {
      'content-range': request.headers['content-range'],
      'x-upload-content-type': request.headers['x-upload-content-type'] as string | undefined,
      'x-upload-content-length': request.headers['x-upload-content-length'] as string | undefined,
    },
    status: 0,
  };

  outsideState.api.push(logged);
  response.once('finish', () => {
    logged.status = response.statusCode;
  });
  outsideState.seen?.(path, method, token);

  const broken = outsideState.broken?.(path, method) ?? null;

  if (broken === 'hang') {
    return;
  }

  if (broken === 'drop') {
    request.socket.destroy();

    return;
  }

  if (!outsideState.valid.has(token)) {
    return json(response, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
  }

  if (broken === 'limit') {
    return refusal(response, 403, 'User rate limit exceeded.', 'userRateLimitExceeded');
  }

  if (broken === 'setup') {
    return refusal(response, 403, 'Google Drive API has not been used in project 1 before or it is disabled.', 'accessNotConfigured');
  }

  if (broken !== null) {
    return refusal(response, broken, 'Internal Error', 'internalError');
  }

  if (path === '/drive/about') {
    return json(response, 200, { user: { displayName: 'Me', emailAddress: outsideState.valid.get(token) } });
  }

  if (path === '/drive/drives') {
    const size = Number(url.searchParams.get('pageSize'));
    const pageToken = url.searchParams.get('pageToken');

    if (pageToken !== null && pageToken !== 'o1') {
      return refusal(response, 400, 'Invalid Value', 'invalid', 'pageToken');
    }

    const offset = pageToken ? 1 : 0;

    return json(response, 200, {
      drives: outsideState.drives.slice(offset, offset + size),
      ...(outsideState.drives.length > offset + size ? { nextPageToken: `o${offset + size}` } : {}),
    });
  }

  if (path === '/drive/files' && method === 'GET') {
    return listFiles(response, url.searchParams);
  }

  const exported = /^\/drive\/files\/([^/]+)\/export$/.exec(path);

  if (exported) {
    const found = entries.get(decodeURIComponent(exported[1]));
    const content = found?.exports?.[url.searchParams.get('mimeType') ?? ''];

    if (found?.file.id === 'heavy-doc') {
      return refusal(response, 403, 'This file is too large to be exported.', 'exportSizeLimitExceeded');
    }

    if (!found || !content) {
      return found ? refusal(response, 400, 'The requested conversion is not supported.', 'badRequest') : noFile(response, exported[1]);
    }

    response.writeHead(200, { 'content-type': url.searchParams.get('mimeType')! });
    response.end(content);

    return;
  }

  const one = /^\/drive\/files\/([^/]*)$/.exec(path);

  if (one && method === 'GET') {
    const found = entries.get(decodeURIComponent(one[1]));

    if (!found || url.searchParams.get('supportsAllDrives') !== 'true') {
      return noFile(response, decodeURIComponent(one[1]));
    }

    if (url.searchParams.get('alt') !== 'media') {
      return json(response, 200, found.file);
    }

    response.writeHead(200, { 'content-type': found.file.mimeType });
    response.end(found.content ?? Buffer.alloc(0));

    return;
  }

  const opened = /^\/upload\/files(?:\/([^/]+))?$/.exec(path);

  if (opened && url.searchParams.get('uploadType') === 'resumable' && (method === 'POST' || method === 'PATCH')) {
    const target = opened[1] ? decodeURIComponent(opened[1]) : null;
    const parent = logged.body?.parents?.[0];

    if ((method === 'PATCH') !== (target !== null)) {
      return refusal(response, 400, 'Bad Request', 'badRequest');
    }

    if (target !== null && !entries.has(target)) {
      return noFile(response, target);
    }

    if (target === 'guarded') {
      return refusal(response, 403, 'The user does not have sufficient permissions for file guarded.', 'insufficientFilePermissions');
    }

    if (parent !== undefined && !entries.has(parent)) {
      return noFile(response, parent);
    }

    const n = String(outsideState.sessions.size + 1);

    outsideState.sessions.set(n, {
      target,
      metadata: logged.body ?? {},
      type: String(request.headers['x-upload-content-type'] ?? ''),
      declared: request.headers['x-upload-content-length'] as string | undefined,
      bytes: Buffer.alloc(0),
      made: null,
    });

    return json(response, 200, {}, { location: outsideState.location ?? `${origin}/upload/session/${n}` });
  }

  const session = /^\/upload\/session\/(\d+)$/.exec(path);

  if (session && method === 'PUT') {
    return serveSession(request, response, session[1], body);
  }

  response.writeHead(404).end();
}

async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', origin);

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
    });
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    const params = new URLSearchParams((await bytesOf(request)).toString('utf8'));
    const refreshToken = params.get('refresh_token') ?? '';
    const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const client = basic ? decodeURIComponent(Buffer.from(basic, 'base64').toString('utf8').split(':')[0]) : params.get('client_id');

    outsideState.refreshes.push(`${client}:${refreshToken}`);

    const fresh = `fresh-${outsideState.refreshes.length}`;

    outsideState.valid.set(fresh, 'me@example.com');

    return json(response, 200, { access_token: fresh, token_type: 'Bearer', expires_in: 3600 });
  }

  if (url.pathname.startsWith('/drive/') || url.pathname.startsWith('/upload/')) {
    return serveDrive(request, response, url);
  }

  response.writeHead(404).end();
}

const requests = (from = 0) => outsideState.api.slice(from).map(request => `${request.method} ${request.url}`);

// The pieces a session was sent since `from`: the range each named and how
// Drive answered it.
const sent = (from: number) =>
  outsideState.api
    .slice(from)
    .filter(request => request.method === 'PUT')
    .map(request => `${request.headers['content-range']} → ${request.status || 'lost'}`);

const paramsOf = (request: { url: string }) => Object.fromEntries(new URL(request.url, origin).searchParams);

// A file of Drive as the node gives it.
const fileOf = (id: string, name: string, mimeType: string, more: Value = {}): Value => ({
  fileId: id,
  name,
  mimeType,
  entryKind: 'file',
  sizeBytes: null,
  createdTime: '2026-10-01T08:00:00.000Z',
  modifiedTime: '2026-11-01T10:00:00.000Z',
  owner: null,
  lastModifiedBy: null,
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
  parentFolderId: 'my-root',
  sharedDriveId: null,
  canEdit: true,
  trashed: false,
  description: null,
  shortcutTargetId: null,
  shortcutTargetMimeType: null,
  exportFormats: null,
  ...more,
});

// ---------------------------------------------------------------------------

before(async () => {
  stand = await startStand();
  process.env.CONSOLE_DOMAIN = 'console.test';
  ({ prisma } = await import('../db/client.ts'));
  files = await import('../files/index.ts');

  outside = http.createServer((request, response) => {
    serve(request, response).catch(error => json(response, 500, { error: String(error) }));
  });
  origin = `http://127.0.0.1:${(await listen(outside, 0, '127.0.0.1')).port}`;
  seed();

  const { connections } = await import('./connections.ts');
  const { driveNode } = await import('./drive.ts');
  const { fileCapabilities } = await import('./files.ts');
  const services = await import('./services.ts');

  catalog = buildCatalog({
    summary: 'The tree of the test.',
    // A recipe of the node names `export_file`: the way a file of the
    // workspace reaches an upload.
    children: [fileCapabilities.exportFile, connections, driveNode({ api: `${origin}/drive`, upload: `${origin}/upload`, authorizationServer: origin })],
  }).catalog;
  services.registerServices(catalog.root);
  port = services.connectionsPort();

  // The OAuth client of the installation, as the operator entered it.
  await prisma.oauthClient.create({ data: { server: 'drive', clientInformation: { client_id: 'client-1', client_secret: 'secret-1' } } });
});

after(async () => {
  await closeServer(outside);
  await stand.stop();
});

describe('drive: the access of the account', () => {
  test('the node waits for an account; an account connected before the tree acts on a token renewed where the node says', async () => {
    assert.equal((await grantNow()).vertices.has('drive'), false);

    // The row of an account as the former path left it: its access token
    // ran out long ago, its refresh token is good.
    await account('default', { access_token: 'old-access', refresh_token: 'good-refresh', obtained_at: aged(7200) }, { identityId: 'me@example.com', identity: { id: 'me@example.com', label: 'me@example.com' } });

    assert.equal((await grantNow()).vertices.has('drive_search_files'), true);

    const read = await drive('get_file', { fileId: 'pdf1', includeContent: false });

    assert.equal(read.file.fileId, 'pdf1');
    assert.deepEqual(outsideState.refreshes, ['client-1:good-refresh']);
    assert.deepEqual(outsideState.api.map(request => request.authorization), ['Bearer fresh-1']);
    assert.equal(((await rowOf('default'))?.tokens as Value).access_token, 'fresh-1');
  });

  test('who fixes a failed request: the caller, the outside system, the operator, nobody', async () => {
    await account('default', { access_token: 'access-1', refresh_token: 'good-refresh' });

    outsideState.broken = () => 'limit';

    const limited = await refuses(
      drive('list_shared_drives'),
      'external_error',
      /^Google Drive refused the request \(HTTP 403 on GET \/drive\/drives\): User rate limit exceeded\. \(userRateLimitExceeded\)$/,
    );

    assert.deepEqual(limited.details, { status: 403 });

    // Only a 403 about the setup of the installation sends to the setup.
    outsideState.broken = () => 'setup';
    await refuses(drive('list_shared_drives'), 'external_error', /\(accessNotConfigured\) Check that the Google Drive API is enabled .* the granted scope is https:\/\/www\.googleapis\.com\/auth\/drive\.$/);

    outsideState.broken = () => 'drop';
    await refuses(drive('list_shared_drives'), 'unavailable', /^Google Drive did not answer: /);

    // A call that is cancelled does not wait for Drive.
    const cancel = new AbortController();

    outsideState.broken = () => 'hang';
    setTimeout(() => cancel.abort(), 50);
    await refuses(drive('list_shared_drives', {}, cancel.signal), 'unavailable', /^The call to Google Drive was cancelled before it answered\.$/);
    outsideState.broken = null;
  });

  test('an account whose identity nobody recorded is asked who it is before another one is added', async () => {
    await account('default', { access_token: 'access-1', refresh_token: 'good-refresh' }, { identityId: null, identity: null });

    const from = outsideState.api.length;
    const link = await invoke('connections_authorize', { service: 'drive', name: 'Work' });

    assert.deepEqual(link.account, { account: 'work', name: 'Work', identity: null, status: 'pending' });
    assert.deepEqual(requests(from), ['GET /drive/about?fields=user']);
    assert.equal((await rowOf('default'))?.identityId, 'me@example.com');
    await prisma.connection.delete({ where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: 'drive', accountKey: 'work' } } });
  });
});

describe('drive: finding', () => {
  test('a search looks through everything the user sees and gives files page by page', async () => {
    const from = outsideState.api.length;
    const first = await drive('search_files', { query: "name contains 'report'", limit: 2, orderBy: 'modifiedTime desc' });

    assert.deepEqual(first, {
      files: [
        fileOf('pdf1', 'report.pdf', 'application/pdf', {
          sizeBytes: PDF.length,
          owner: 'Anna <anna@example.com>',
          lastModifiedBy: 'me@example.com',
          parentFolderId: 'f-reports',
          description: 'The final report',
        }),
        fileOf('sc1', 'report (shortcut)', SHORTCUT, { entryKind: 'shortcut', shortcutTargetId: 'pdf1', shortcutTargetMimeType: 'application/pdf' }),
      ],
      nextCursor: 'o2',
      incompleteSearch: false,
    });

    const asked = paramsOf(outsideState.api[from]);

    assert.deepEqual(
      { ...asked, fields: '' },
      { q: "name contains 'report'", pageSize: '2', orderBy: 'modifiedTime desc', corpora: 'allDrives', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', fields: '' },
    );
    assert.match(asked.fields, /^nextPageToken,incompleteSearch,files\(id,name,mimeType,size,/);

    // The trash is searched too; a shared drive narrows the search.
    outsideState.incomplete = 'everything';

    const second = await drive('search_files', { query: "name contains 'report'", limit: 2, cursor: first.nextCursor });

    assert.deepEqual([second.files.map((file: Value) => [file.fileId, file.trashed]), second.nextCursor, second.incompleteSearch], [[['binned', true], ['sd-file', false]], null, true]);
    outsideState.incomplete = false;

    const team = await drive('search_files', { query: '', sharedDriveId: 'sd1' });

    assert.deepEqual(team.files.map((file: Value) => [file.fileId, file.sharedDriveId, file.entryKind]), [['sd1', 'sd1', 'folder'], ['sd-file', 'sd1', 'file']]);
    assert.deepEqual(
      (({ q, corpora, driveId }) => ({ q, corpora, driveId }))(paramsOf(outsideState.api.at(-1)!)),
      { q: undefined, corpora: 'drive', driveId: 'sd1' },
    );
  });

  test('what Drive does not take in a search is the call\'s to change', async () => {
    await refuses(
      drive('search_files', { query: 'a syntax error' }),
      'invalid_input',
      /^Google Drive rejects the search as malformed \(Invalid Value \(invalid in q\)\): check query\.$/,
    );
    await refuses(drive('search_files', { query: 'x', orderBy: 'bogus' }), 'invalid_input', /\(invalid in orderBy\)\): check query and orderBy\.$/);
    await refuses(drive('search_files', { query: 'x', cursor: 'bogus' }), 'invalid_input', /^cursor is not a nextCursor of this list/);
    await refuses(drive('search_files', { query: 'x', cursor: '' }), 'invalid_input', /^cursor is empty/);
    await refuses(drive('search_files', { query: 'x', sharedDriveId: 'sd9' }), 'not_found', /^There is no shared drive "sd9" \(sharedDriveId\) among the shared drives of the account "default"\.$/);
    await refuses(drive('search_files', { query: 'x', limit: 51 }), 'invalid_input', /limit/);
  });

  test('a folder is listed one level down: subfolders first, the trash left out', async () => {
    const from = outsideState.api.length;
    const top = await drive('list_folder', { limit: 3 });

    assert.deepEqual(top.files.map((file: Value) => [file.fileId, file.entryKind]), [['f-empty', 'folder'], ["o'hara", 'folder'], ['f-reports', 'folder']]);
    // The top of My Drive is listed in the user's own corpus, with no
    // question about the folder.
    assert.deepEqual(
      (({ q, orderBy, pageSize, corpora }) => ({ q, orderBy, pageSize, corpora }))(paramsOf(outsideState.api[from])),
      { q: "'root' in parents and trashed = false", orderBy: 'folder,name', pageSize: '3', corpora: 'user' },
    );

    const next = await drive('list_folder', { limit: 3, cursor: top.nextCursor });

    assert.deepEqual([next.files[0].fileId, next.files[0].name], ['huge', 'backup.zip']);
    assert.equal(typeof next.nextCursor, 'string');

    const reports = await drive('list_folder', { folderId: 'f-reports' });

    assert.deepEqual(
      reports.files.map((file: Value) => [file.fileId, file.entryKind, file.exportFormats?.[0] ?? null]),
      [['sheet1', 'google_document', 'xlsx'], ['doc1', 'google_document', 'docx'], ['pdf1', 'file', null]],
    );
    assert.equal(reports.nextCursor, null);
    // The folder is asked what it is and where it lives, then listed there.
    assert.deepEqual(requests(-2).map(line => line.split(/[?&]fields/)[0]), ['GET /drive/files/f-reports?supportsAllDrives=true', 'GET /drive/files?pageSize=50']);
    assert.equal(paramsOf(outsideState.api.at(-1)!).corpora, 'user');

    // A folder of a shared drive — its root too — is listed in that drive.
    assert.deepEqual((await drive('list_folder', { folderId: 'sd1' })).files.map((file: Value) => file.fileId), ['sd-file']);
    assert.deepEqual((({ corpora, driveId }) => ({ corpora, driveId }))(paramsOf(outsideState.api.at(-1)!)), { corpora: 'drive', driveId: 'sd1' });

    // An id is quoted for the query, whatever it holds; an empty folder is
    // an empty list.
    assert.deepEqual(await drive('list_folder', { folderId: "o'hara" }), { files: [], nextCursor: null });
    assert.equal(paramsOf(outsideState.api.at(-1)!).q, "'o\\'hara' in parents and trashed = false");
    assert.deepEqual(await drive('list_folder', { folderId: 'f-empty' }), { files: [], nextCursor: null });
  });

  test('a folder is listed whole or not at all: a list Drive calls incomplete is not its content', async () => {
    // A search through every shared drive may come incomplete; the list of
    // a folder does not look there.
    outsideState.incomplete = 'everything';
    assert.equal((await drive('search_files', { query: '' })).incompleteSearch, true);
    assert.equal((await drive('list_folder', { folderId: 'f-reports' })).files.length, 3);
    assert.deepEqual((await drive('list_folder', { folderId: 'sd1' })).files.map((file: Value) => file.fileId), ['sd-file']);

    outsideState.incomplete = 'always';
    await refuses(drive('list_folder'), 'unavailable', /^Google Drive could not look through the whole folder "root" this time: nothing is listed\. Try again\.$/);
    await refuses(drive('list_folder', { folderId: 'sd1', limit: 1 }), 'unavailable', /the whole folder "sd1"/);
    outsideState.incomplete = false;
  });

  test('an id that names no folder is not listed as an empty one', async () => {
    await refuses(drive('list_folder', { folderId: 'nowhere' }), 'not_found', /^There is no folder "nowhere" that the account "default" can see in Google Drive\.$/);
    await refuses(drive('list_folder', { folderId: 'pdf1' }), 'not_found', /^"pdf1" is not a folder: it is the file "report\.pdf" \(application\/pdf\)\.$/);
    await refuses(drive('list_folder', { folderId: 'sc-folder' }), 'not_found', /^"sc-folder" is not a folder: it is a shortcut to "f-reports"\.$/);
    await refuses(drive('list_folder', { folderId: 'pdf1', cursor: 'o1' }), 'not_found', /^"pdf1" is not a folder/);
    await refuses(drive('list_folder', { folderId: ' ' }), 'invalid_input', /^folderId is empty/);
    await refuses(drive('list_folder', { cursor: 'bogus' }), 'invalid_input', /^cursor is not a nextCursor of this list/);
  });

  test('the shared drives are listed page by page', async () => {
    const first = await drive('list_shared_drives', { limit: 1 });

    assert.deepEqual(first, { sharedDrives: [{ sharedDriveId: 'sd1', name: 'Team', createdTime: '2026-01-05T09:00:00.000Z' }], nextCursor: 'o1' });
    assert.deepEqual(await drive('list_shared_drives', { limit: 1, cursor: 'o1' }), {
      sharedDrives: [{ sharedDriveId: 'sd2', name: 'Archive', createdTime: null }],
      nextCursor: null,
    });
    await refuses(drive('list_shared_drives', { cursor: 'bogus' }), 'invalid_input', /^cursor is not a nextCursor of this list/);
  });
});

describe('drive: reading', () => {
  test('a file is read with its text: a Google document in the text format of its type, a text file as it is', async () => {
    const from = outsideState.api.length;
    const doc = await drive('get_file', { fileId: 'doc1' });

    // The cut does not split a character.
    assert.deepEqual(
      { ...doc, content: doc.content.length },
      {
        file: fileOf('doc1', 'Plan', DOC, { entryKind: 'google_document', parentFolderId: 'f-reports', exportFormats: ['docx', 'pdf', 'txt', 'md', 'html', 'odt', 'rtf', 'epub'] }),
        content: 19_999,
        contentFormat: 'md',
        contentTruncated: true,
      },
    );
    assert.deepEqual(requests(from).map(line => line.split('&fields')[0]), ['GET /drive/files/doc1?supportsAllDrives=true', 'GET /drive/files/doc1/export?mimeType=text%2Fmarkdown']);

    const read = async (fileId: string) => (({ content, contentFormat, contentTruncated }) => [content, contentFormat, contentTruncated])(await drive('get_file', { fileId }));

    assert.deepEqual(await read('sheet1'), ['a,b\n1,2\n', 'csv', false]);
    assert.deepEqual(await read('slides1'), ['Slide one\nSlide two', 'txt', false]);
    assert.deepEqual(await read('txt1'), ['plain notes — заметки', 'raw', false]);

    // No text form: a binary file, a Drawing, a text file too large to
    // read, a folder — and whatever the call did not ask the text of.
    for (const fileId of ['pdf1', 'drawing1', 'big-text', 'f-reports', 'form1']) {
      assert.deepEqual(await read(fileId), [null, null, false], fileId);
    }

    const before = outsideState.api.length;

    assert.deepEqual(await read('big-text'), [null, null, false]);
    assert.equal(outsideState.api.length, before + 1, 'the bytes of a file without a text form are not asked for');

    const bare = await drive('get_file', { fileId: 'doc1', includeContent: false });

    assert.deepEqual([bare.content, bare.contentFormat, bare.contentTruncated, outsideState.api.at(-1)?.url.includes('/export')], [null, null, false, false]);
  });

  test('a shortcut is followed to its target; a file that is not there is told as missing', async () => {
    const viaShortcut = await drive('get_file', { fileId: 'sc1' });

    assert.deepEqual([viaShortcut.file.fileId, viaShortcut.file.entryKind, viaShortcut.file.shortcutTargetId], ['pdf1', 'file', null]);
    await refuses(drive('get_file', { fileId: 'sc-gone' }), 'not_found', /^The file "sc-gone" is a shortcut, and its target "nowhere" is gone or is not visible to the account "default"\.$/);
    await refuses(drive('get_file', { fileId: 'nowhere' }), 'not_found', /^There is no file "nowhere" that the account "default" can see in Google Drive\.$/);
    await refuses(drive('get_file', { fileId: '' }), 'invalid_input', /^fileId is empty/);
    // What Drive refuses to export is its refusal, not a file without text.
    await refuses(drive('get_file', { fileId: 'heavy-doc' }), 'external_error', /This file is too large to be exported\. \(exportSizeLimitExceeded\)$/);
  });

  test('a download lands in storage: a regular file as it is, a Google document exported', async () => {
    const report = await drive('download_file', { fileId: 'sc1' });

    assert.deepEqual({ ...report, id: '' }, { kind: 'file', id: '', name: 'report.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, width: null, height: null });
    assert.deepEqual(await storedBytes(report.id), PDF);
    assert.equal((await files.getWorkspaceFile(stand.workspaceId, report.id)).scope, 'drive');
    assert.match(outsideState.api.at(-1)!.url, /^\/drive\/files\/pdf1\?supportsAllDrives=true&alt=media$/);

    // The format of the type by default, the one the call names otherwise;
    // the name says what the file is now.
    const plan = await drive('download_file', { fileId: 'doc1' });

    assert.deepEqual([plan.name, plan.contentType, (await storedBytes(plan.id)).toString()], ['Plan.docx', DOCX, 'docx bytes']);

    const printed = await drive('download_file', { fileId: 'doc1', format: 'pdf' });

    assert.deepEqual([printed.name, printed.contentType, (await storedBytes(printed.id)).toString()], ['Plan.pdf', 'application/pdf', 'pdf of the plan']);
    assert.equal((await drive('download_file', { fileId: 'sheet1' })).name, 'Budget.xlsx');
    assert.equal((await drive('download_file', { fileId: 'txt1', format: 'pdf' })).name, 'notes.txt');
  });

  test('what cannot be downloaded is refused before a byte is asked for', async () => {
    const from = outsideState.api.length;

    await refuses(drive('download_file', { fileId: 'f-reports' }), 'invalid_input', /^"Reports" is a folder: its files are downloaded one by one\.$/);
    await refuses(drive('download_file', { fileId: 'form1' }), 'invalid_input', /^"Survey" is a Google file of the type application\/vnd\.google-apps\.form, which cannot be exported\.$/);

    const format = await refuses(
      drive('download_file', { fileId: 'sheet1', format: 'docx' }),
      'invalid_input',
      /^The format "docx" is not available for "Budget\.xlsx" \(application\/vnd\.google-apps\.spreadsheet\): pass one of xlsx, pdf, csv, tsv, ods\.$/,
    );

    assert.deepEqual(format.details, { exportFormats: ['xlsx', 'pdf', 'csv', 'tsv', 'ods'] });
    // Drive gives a Sheet as a web page only zipped: html is a format of a Doc.
    await refuses(drive('download_file', { fileId: 'sheet1', format: 'html' }), 'invalid_input', /^The format "html" is not available for "Budget\.xlsx"/);
    await refuses(drive('download_file', { fileId: 'huge' }), 'invalid_input', /^"backup\.zip" is 300000001 bytes, over the 300000000 bytes a download takes: nothing was stored\.$/);
    await refuses(drive('download_file', { fileId: 'doc1', format: 'zip' }), 'invalid_input', /format/);
    assert.ok(requests(from).every(line => !/alt=media|\/export/.test(line)), requests(from).join(' | '));

    await refuses(drive('download_file', { fileId: 'nowhere' }), 'not_found', /^There is no file "nowhere"/);
    await refuses(drive('download_file', { fileId: 'heavy-doc' }), 'external_error', /^Google Drive refused the request \(HTTP 403 on GET \/drive\/files\/heavy-doc\/export\): This file is too large to be exported\. \(exportSizeLimitExceeded\)$/);
  });
});

describe('drive: writing', () => {
  test('a stored file becomes a new file of Drive: a session is opened, the bytes follow', async () => {
    const fileId = await stored('notes.md', 'text/markdown', Buffer.from('# Notes\n'));
    const from = outsideState.api.length;
    const made = await drive('upload_file', { file: fileId });

    assert.deepEqual(made, fileOf(made.fileId, 'notes.md', 'text/markdown', { sizeBytes: 8 }));
    assert.equal(outsideState.entries.get(made.fileId)?.content?.toString(), '# Notes\n');

    const [opened, piece] = outsideState.api.slice(from);

    assert.match(opened.url, /^\/upload\/files\?uploadType=resumable&supportsAllDrives=true&fields=id%2Cname/);
    assert.deepEqual([opened.method, opened.body, opened.headers['x-upload-content-type'], opened.headers['x-upload-content-length']], ['POST', { name: 'notes.md' }, 'text/markdown', '8']);
    assert.deepEqual([piece.method, piece.headers['content-range'], piece.status], ['PUT', 'bytes 0-7/8', 201]);
    assert.equal(outsideState.api.length, from + 2);

    // A folder, a name and a Google document to become are the call's.
    const doc = await drive('upload_file', { file: fileId, folderId: 'f-reports', name: ' Notes of the week ', convertTo: 'document' });

    assert.deepEqual([doc.name, doc.mimeType, doc.entryKind, doc.parentFolderId], ['Notes of the week', DOC, 'google_document', 'f-reports']);
    assert.deepEqual(outsideState.api.at(-2)?.body, { name: 'Notes of the week', parents: ['f-reports'], mimeType: DOC });

    // A file stored without a telling type goes by the type of its name.
    await drive('upload_file', { file: await stored('table.csv', 'application/octet-stream', Buffer.from('a,b\n')) });
    assert.equal(outsideState.api.at(-2)?.headers['x-upload-content-type'], 'text/csv');
  });

  test('a document of the workspace reaches Drive with the type its conversion needs', async () => {
    // The way the guide of the node names: `export_file`, with no type
    // said, then the upload.
    const area = path.join(stand.dir, 'data', 'workspace', stand.workspaceId, 'files');

    await fs.mkdir(area, { recursive: true });
    await fs.writeFile(path.join(area, 'letter.docx'), 'the bytes of a letter');

    const letter = await invoke('export_file', { path: 'letter.docx' });

    assert.equal(letter.contentType, DOCX);

    const doc = await drive('upload_file', { file: letter.id, convertTo: 'document' });

    assert.equal(doc.mimeType, DOC);
    assert.deepEqual([outsideState.api.at(-2)?.body, outsideState.api.at(-2)?.headers['x-upload-content-type']], [{ name: 'letter.docx', mimeType: DOC }, DOCX]);

    // A table stored before its type was known by its name goes the same.
    const sheet = await drive('upload_file', { file: await stored('budget.xlsx', 'application/octet-stream', Buffer.from('the bytes of a table')), convertTo: 'spreadsheet' });

    assert.equal(sheet.mimeType, SHEET);
    assert.equal(outsideState.api.at(-2)?.headers['x-upload-content-type'], XLSX);
  });

  test('a large file goes piece by piece: Drive says how much it holds, and the next piece starts there', async () => {
    const big = Buffer.alloc(2 * PIECE + 3);

    for (let at = 0; at < big.length; at += 4099) {
      big.writeUInt32LE(at, Math.min(at, big.length - 4));
    }

    const fileId = await stored('big.bin', 'application/octet-stream', big);
    let from = outsideState.api.length;
    const made = await drive('upload_file', { file: fileId });

    assert.deepEqual(sent(from), [
      `bytes 0-${PIECE - 1}/${big.length} → 308`,
      `bytes ${PIECE}-${2 * PIECE - 1}/${big.length} → 308`,
      `bytes ${2 * PIECE}-${2 * PIECE + 2}/${big.length} → 201`,
    ]);
    assert.equal(made.sizeBytes, big.length);
    assert.ok(outsideState.entries.get(made.fileId)!.content!.equals(big));

    // Drive kept less of a piece than it was sent: what it did not keep is
    // sent again, from where its range ends.
    from = outsideState.api.length;
    outsideState.pieces = [PIECE / 2];

    const again = await drive('upload_file', { file: fileId, name: 'again.bin' });

    assert.deepEqual(sent(from), [
      `bytes 0-${PIECE - 1}/${big.length} → 308`,
      `bytes ${PIECE / 2}-${PIECE - 1}/${big.length} → 308`,
      `bytes ${PIECE}-${2 * PIECE - 1}/${big.length} → 308`,
      `bytes ${2 * PIECE}-${2 * PIECE + 2}/${big.length} → 201`,
    ]);
    assert.ok(outsideState.entries.get(again.fileId)!.content!.equals(big));

    // A file whose size storage does not know says its size with the last
    // piece.
    await prisma.file.update({ where: { id: fileId }, data: { sizeBytes: null } });
    from = outsideState.api.length;

    const unsized = await drive('upload_file', { file: fileId, name: 'unsized.bin' });

    assert.equal(outsideState.api[from].headers['x-upload-content-length'], undefined);
    assert.deepEqual(sent(from), [
      `bytes 0-${PIECE - 1}/* → 308`,
      `bytes ${PIECE}-${2 * PIECE - 1}/* → 308`,
      `bytes ${2 * PIECE}-${2 * PIECE + 2}/${big.length} → 201`,
    ]);
    assert.ok(outsideState.entries.get(unsized.fileId)!.content!.equals(big));
  });

  test('a piece that got no answer is not sent blindly again: the session is asked what it holds', async () => {
    const body = Buffer.alloc(PIECE + 5, 7);
    const fileId = await stored('data.bin', 'application/octet-stream', body);
    let from = outsideState.api.length;

    // The first piece is lost on the way, then arrives while its answer is
    // lost; the last piece arrives, and its answer is lost too.
    outsideState.pieces = ['piece', 'answer', 'answer'];

    const made = await drive('upload_file', { file: fileId });

    assert.deepEqual(sent(from), [
      `bytes 0-${PIECE - 1}/${body.length} → lost`,
      `bytes */${body.length} → 308`,
      `bytes 0-${PIECE - 1}/${body.length} → lost`,
      `bytes */${body.length} → 308`,
      `bytes ${PIECE}-${PIECE + 4}/${body.length} → lost`,
      `bytes */${body.length} → 200`,
    ]);
    assert.ok(outsideState.entries.get(made.fileId)!.content!.equals(body));

    // Drive that keeps losing pieces is not asked for ever. The session
    // never got its last piece: there is no file.
    from = outsideState.api.length;
    outsideState.pieces = ['piece', 'piece', 'piece', 'piece'];
    await refuses(
      drive('upload_file', { file: fileId }),
      'unavailable',
      /^The upload was given up: Google Drive failed it 4 times, the last one — Google Drive did not answer: .*\. No file was made in Drive\.$/,
    );
    assert.equal(sent(from).length, 7);
    assert.deepEqual(outsideState.pieces, []);
  });

  test('a failure of Drive in the middle of an upload is asked about too: a 503, an answer that breaks off', async () => {
    const body = Buffer.alloc(PIECE + 5, 9);
    const fileId = await stored('report.bin', 'application/octet-stream', body);
    const before = outsideState.entries.size;
    let from = outsideState.api.length;

    // A 503 to a piece Drive did not keep, then a 503 to the last piece it
    // did keep: the session says what it holds, and the file it made.
    outsideState.pieces = ['busy', 'kept', 'kept-busy'];

    const made = await drive('upload_file', { file: fileId });

    assert.deepEqual(sent(from), [
      `bytes 0-${PIECE - 1}/${body.length} → 503`,
      `bytes */${body.length} → 308`,
      `bytes 0-${PIECE - 1}/${body.length} → 308`,
      `bytes ${PIECE}-${PIECE + 4}/${body.length} → 503`,
      `bytes */${body.length} → 200`,
    ]);
    assert.ok(outsideState.entries.get(made.fileId)!.content!.equals(body));
    assert.equal(outsideState.entries.size, before + 1, 'one file was made');

    // The answer that carries the file breaks off inside its body.
    from = outsideState.api.length;
    outsideState.pieces = ['cut'];

    const replaced = await drive('update_file', { fileId: 'txt1', text: 'whole' });

    assert.deepEqual(sent(from), ['bytes 0-4/5 → lost', 'bytes */5 → 200']);
    assert.deepEqual([replaced.fileId, replaced.sizeBytes, outsideState.entries.get('txt1')?.content?.toString()], ['txt1', 5, 'whole']);
  });

  test('an upload that cannot go on is given up, and the caller is told what became of the file', async () => {
    const small = await stored('small.bin', 'application/octet-stream', Buffer.from('small'));
    let from = outsideState.api.length;

    // The last piece was on the way every time: Drive may have made the
    // file, and a blind repeat would make another.
    outsideState.pieces = ['busy', 'busy', 'busy', 'busy'];
    await refuses(
      drive('upload_file', { file: small }),
      'unavailable',
      /^The upload was given up: Google Drive failed it 4 times, the last one — Google Drive refused the request \(HTTP 503 on PUT \/upload\/session\/\d+\): Backend Error \(backendError\)\. Whether Drive made the file is not known: look for it in Drive before uploading again, or there may be two\.$/,
    );
    assert.deepEqual(sent(from).map(line => line.split(' → ')[1]), ['503', '308', '503', '308', '503', '308', '503']);

    outsideState.pieces = ['busy', 'busy', 'busy', 'busy'];
    await refuses(drive('update_file', { fileId: 'txt1', text: 'again' }), 'unavailable', /Whether the content was replaced is not known: read the file to see; replacing it again is safe\.$/);
    assert.equal(outsideState.entries.get('txt1')?.content?.toString(), 'whole');

    // A session that answers and keeps nothing is not sent the same piece
    // for ever.
    from = outsideState.api.length;
    outsideState.pieces = [0, 0, 0, 0];
    await refuses(
      drive('upload_file', { file: small }),
      'external_error',
      /^The upload was given up: Google Drive keeps taking no bytes into its upload session, which holds 0\. No file was made in Drive\.$/,
    );
    assert.deepEqual(sent(from), ['bytes 0-4/5 → 308', 'bytes 0-4/5 → 308', 'bytes 0-4/5 → 308', 'bytes 0-4/5 → 308']);
    assert.deepEqual(outsideState.pieces, []);
  });

  test('the token and the bytes go only to the upload endpoint: a session opened elsewhere is not sent to', async () => {
    const fileId = await stored('secret.txt', 'text/plain', Buffer.from('secret'));
    const from = outsideState.api.length;

    outsideState.location = 'https://uploads.example.net/session/1';
    await refuses(drive('upload_file', { file: fileId }), 'external_error', /^Google Drive named an address for the upload that is not its upload endpoint: nothing was sent to it\.$/);
    outsideState.location = null;
    assert.deepEqual(sent(from), []);
  });

  test('a token Drive refuses in the middle of an upload is renewed, and the piece goes out again', async () => {
    await account('default', { access_token: 'access-1', refresh_token: 'good-refresh' });

    const fileId = await stored('late.txt', 'text/plain', Buffer.from('late'));
    const refreshes = outsideState.refreshes.length;
    const from = outsideState.api.length;

    outsideState.seen = (path, method) => {
      if (method === 'PUT') {
        outsideState.valid.delete('access-1');
        outsideState.seen = null;
      }
    };

    const made = await drive('upload_file', { file: fileId });

    assert.equal(outsideState.entries.get(made.fileId)?.content?.toString(), 'late');
    assert.equal(outsideState.refreshes.length, refreshes + 1);
    assert.deepEqual(
      outsideState.api.slice(from).map(request => [request.method, request.authorization === 'Bearer access-1', request.status]),
      [['POST', true, 200], ['PUT', true, 401], ['PUT', false, 201]],
    );
    outsideState.valid.set('access-1', 'me@example.com');
    await account('default', { access_token: 'access-1', refresh_token: 'good-refresh' });
  });

  test('what an upload cannot take is refused before a session is opened', async () => {
    const fileId = await stored('small.txt', 'text/plain', Buffer.from('small'));
    const from = outsideState.api.length;

    await refuses(drive('upload_file', { file: 'file_nothing' }), 'not_found', /^There is no stored file "file_nothing" in the workspace\.$/);
    await refuses(drive('upload_file', { file: fileId, name: '  ' }), 'invalid_input', /^name is blank/);

    await prisma.file.update({ where: { id: fileId }, data: { sizeBytes: 150_000_001 } });
    await refuses(drive('upload_file', { file: fileId }), 'invalid_input', /^The stored file is 150000001 bytes, over the 150000000 bytes an upload into Drive takes: nothing was uploaded\.$/);
    await refuses(drive('update_file', { fileId: 'txt1', file: fileId }), 'invalid_input', /^The stored file is 150000001 bytes/);
    await prisma.file.update({ where: { id: fileId }, data: { sizeBytes: 5 } });
    assert.equal(outsideState.api.length, from);

    await refuses(drive('upload_file', { file: fileId, folderId: 'nowhere' }), 'not_found', /^There is no folder "nowhere" \(folderId\) that the account "default" can see in Google Drive\.$/);
    assert.deepEqual(sent(from), []);
  });

  test('the content of a file is replaced by a stored file or by text; the file stays what it is', async () => {
    const from = outsideState.api.length;
    const doc = await drive('update_file', { fileId: 'doc1', text: '# New plan — план', textFormat: 'markdown' });

    // A Google document imports the content and stays the document it was.
    assert.deepEqual([doc.fileId, doc.mimeType, doc.entryKind, doc.name], ['doc1', DOC, 'google_document', 'Plan']);
    assert.equal(outsideState.entries.get('doc1')?.content?.toString(), '# New plan — план');

    const [, opened, piece] = outsideState.api.slice(from);

    assert.match(opened.url, /^\/upload\/files\/doc1\?uploadType=resumable&supportsAllDrives=true&fields=/);
    assert.deepEqual([opened.method, opened.body, opened.headers['x-upload-content-type']], ['PATCH', {}, 'text/markdown; charset=UTF-8']);
    assert.deepEqual([piece.headers['content-range'], piece.status], ['bytes 0-22/23', 200]);

    // A shortcut is followed; the bytes of a stored file replace the bytes.
    const replaced = await drive('update_file', { fileId: 'sc1', file: await stored('v2.pdf', 'application/pdf', Buffer.from('%PDF v2')) });

    assert.deepEqual([replaced.fileId, replaced.name, replaced.sizeBytes], ['pdf1', 'report.pdf', 7]);
    assert.equal(outsideState.entries.get('pdf1')?.content?.toString(), '%PDF v2');

    // A text is read as plain unless the call says otherwise; an empty one
    // empties the file.
    const emptied = await drive('update_file', { fileId: 'txt1', text: '' });

    assert.deepEqual([emptied.sizeBytes, outsideState.api.at(-2)?.headers['x-upload-content-type'], outsideState.api.at(-1)?.headers['content-range']], [0, 'text/plain; charset=UTF-8', 'bytes */0']);
  });

  test('what cannot be replaced is refused: by the call, by Drive', async () => {
    const fileId = await stored('new.txt', 'text/plain', Buffer.from('new'));
    const from = outsideState.api.length;

    await refuses(drive('update_file', { fileId: 'txt1' }), 'invalid_input', /exactly one of/i);
    await refuses(drive('update_file', { fileId: 'txt1', file: fileId, text: 'x' }), 'invalid_input', /exactly one of/i);
    await refuses(drive('update_file', { fileId: 'txt1', file: 'file_nothing' }), 'not_found', /^There is no stored file "file_nothing" in the workspace\.$/);
    assert.equal(outsideState.api.length, from);

    await refuses(drive('update_file', { fileId: 'nowhere', text: 'x' }), 'not_found', /^There is no file "nowhere" that the account "default" can see in Google Drive\.$/);
    await refuses(drive('update_file', { fileId: 'f-reports', text: 'x' }), 'invalid_input', /^"Reports" is a folder: only the content of a file can be replaced\.$/);
    await refuses(drive('update_file', { fileId: 'locked', text: 'x' }), 'external_error', /^Google Drive gives the account "default" no edit permission for "contract\.txt"\.$/);
    // A right Drive denies only when asked is its refusal, in its words —
    // and no matter for the operator.
    await refuses(
      drive('update_file', { fileId: 'guarded', text: 'x' }),
      'external_error',
      /^Google Drive refused the request \(HTTP 403 on PATCH \/upload\/files\/guarded\): The user does not have sufficient permissions for file guarded\. \(insufficientFilePermissions\)$/,
    );
    assert.deepEqual(sent(from), []);
    assert.equal(outsideState.entries.get('locked')?.content?.toString(), 'signed');
  });
});
