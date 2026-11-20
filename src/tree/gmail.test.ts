// The node `gmail` over the stand's database, called the way every caller
// reaches it: through a grant and the one path of a call (src/catalog), on
// the connections port of the tree. The outside is local: an authorization
// server that renews tokens and a server that answers as the Gmail API
// does. No consent page is walked — an account is a row the way the
// callback left it, one written before the tree existed included.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
const gmail = (name: string, input: JsonObject = {}) => invoke(`gmail_${name}`, { account: 'default', ...input });

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
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: 'gmail', accountKey } },
    create: { workspaceId: stand.workspaceId, server: 'gmail', accountKey, ...data },
    update: data,
  });
}

async function rowOf(accountKey: string) {
  return prisma.connection.findUnique({
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: 'gmail', accountKey } },
  });
}

// ---------------------------------------------------------------------------
// The outside: the authorization server and the Gmail API

const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64url');
const headers = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));

function message(id: string, threadId: string, values: Record<string, string>, parts: Value[], more: Value = {}): Value {
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    snippet: `snippet of ${id}`,
    internalDate: String(Date.parse('2026-11-01T10:00:00Z')),
    payload: { mimeType: 'multipart/mixed', headers: headers(values), parts },
    ...more,
  };
}

const LONG_BODY = `Hello Anna,\n${'A long line of the report. '.repeat(2000)}\nBye`;
const PDF = Buffer.from('%PDF-1.7 the bytes of a report');

const outsideState = {
  // The access tokens the API lets in, and whose mailbox each opens.
  valid: new Map<string, string>([['access-1', 'me@example.com']]),
  refreshes: [] as string[],
  api: [] as Array<{ method: string; url: string; authorization: string | undefined; body: Value | null }>,
  // How the API answers instead of its own way: a status, or no answer.
  broken: null as null | ((path: string) => number | 'drop' | 'hang' | null),
  messages: new Map<string, Value>(),
  threads: new Map<string, string[]>(),
  drafts: new Map<string, Value>(),
  // The pages of a search, by page token ('' is the first).
  found: new Map<string, { ids: string[]; next?: string }>(),
  created: 0,
};

function seed(): void {
  const { messages, threads, found } = outsideState;

  messages.set(
    'm1',
    message('m1', 't1', { From: 'Anna <anna@example.com>', To: 'me@example.com', Cc: 'boss@example.com', Subject: 'The report', 'Message-ID': '<m1@mail.example.com>', References: '<m0@mail.example.com>' }, [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain; charset=utf-8', body: { size: LONG_BODY.length, data: b64(LONG_BODY) } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'report.pdf', body: { size: PDF.length, attachmentId: 'att-1' } },
      { partId: '2', mimeType: 'text/plain', filename: 'notes.txt', body: { size: 5, data: b64('notes') } },
      { partId: '3', mimeType: 'image/png', filename: 'scan.png', body: { size: 3, data: b64('one') } },
      { partId: '4', mimeType: 'image/png', filename: 'scan.png', body: { size: 3, data: b64('two') } },
      { partId: '5', mimeType: 'application/zip', filename: 'empty.zip', body: { size: 0, attachmentId: 'att-gone' } },
    ]),
  );
  messages.set(
    'm2',
    message('m2', 't1', { From: 'me@example.com', To: 'anna@example.com', Subject: 'Re: The report', 'Message-ID': '<m2@mail.example.com>' }, [
      {
        mimeType: 'text/html',
        body: { data: b64('<html><head><style>p{color:red}</style></head><body><p>Thanks &amp; regards,</p><div>Me&nbsp;&#x263A;</div><br>P.S. &lt;soon&gt;</body></html>') },
      },
    ]),
  );
  messages.set('m3', message('m3', 't3', { From: 'robot@example.com', 'Message-ID': '<m3@mail.example.com>' }, []));

  for (const n of [1, 2, 3, 4, 5]) {
    messages.set(`p${n}`, message(`p${n}`, 'long', { Subject: `Part ${n}` }, [{ mimeType: 'text/plain', body: { data: b64(`body ${n}`) } }]));
  }

  threads.set('t1', ['m1', 'm2']);
  threads.set('long', ['p1', 'p2', 'p3', 'p4', 'p5']);
  found.set('', { ids: ['m1', 'gone', 'm2'], next: 'page-2' });
  found.set('page-2', { ids: ['m3'] });
}

async function bodyOf(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

// A refusal as Google words it.
const refusal = (response: http.ServerResponse, code: number, status: string, text: string) =>
  json(response, code, { error: { code, message: text, status } });

const notFound = (response: http.ServerResponse) => refusal(response, 404, 'NOT_FOUND', 'Requested entity was not found.');

function draftOf(raw: Value): Value {
  const n = (outsideState.created += 1);

  return { id: `d${n}`, message: { id: `dm${n}`, threadId: raw.threadId ?? `dt${n}`, raw: raw.raw, snippet: `draft ${n}` } };
}

async function serveGmail(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.slice('/gmail'.length);
  const method = request.method ?? 'GET';
  const text = await bodyOf(request);
  const body = text ? (JSON.parse(text) as Value) : null;
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
  const { messages, threads, drafts, found } = outsideState;

  outsideState.api.push({ method, url: `${path}${url.search}`, authorization: request.headers.authorization, body });

  const broken = outsideState.broken?.(path) ?? null;

  if (broken === 'hang') {
    return;
  }

  if (broken === 'drop') {
    request.socket.destroy();

    return;
  }

  if (!outsideState.valid.has(token)) {
    return refusal(response, 401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
  }

  if (broken !== null) {
    return broken === 403
      ? refusal(response, 403, 'PERMISSION_DENIED', 'Gmail API has not been used in project 1 before or it is disabled.')
      : refusal(response, broken, 'INTERNAL', 'Backend Error');
  }

  if (path === '/profile') {
    return json(response, 200, { emailAddress: outsideState.valid.get(token) });
  }

  if (path === '/messages' && method === 'GET') {
    const page = found.get(url.searchParams.get('pageToken') ?? '');

    return page
      ? json(response, 200, {
          messages: page.ids.map(id => ({ id, threadId: messages.get(id)?.threadId ?? 'x' })),
          ...(page.next ? { nextPageToken: page.next } : {}),
          resultSizeEstimate: 4,
        })
      : refusal(response, 400, 'INVALID_ARGUMENT', 'Invalid pageToken');
  }

  if (path === '/messages/send' && method === 'POST') {
    return json(response, 200, { id: 'sent-mail', threadId: body?.threadId ?? 'new-thread', labelIds: ['SENT'] });
  }

  const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);

  if (attachment) {
    return attachment[2] === 'att-1' ? json(response, 200, { size: PDF.length, data: b64(PDF) }) : json(response, 200, { size: 0 });
  }

  const one = /^\/(messages|threads|drafts)\/([^/]+)$/.exec(path);

  if (one?.[1] === 'messages') {
    const found = messages.get(decodeURIComponent(one[2]));

    return found ? json(response, 200, found) : /^[a-z0-9]+$/.test(one[2]) ? notFound(response) : refusal(response, 400, 'INVALID_ARGUMENT', 'Invalid id value');
  }

  if (one?.[1] === 'threads') {
    const ids = threads.get(one[2]);

    return ids ? json(response, 200, { id: one[2], messages: ids.map(id => messages.get(id)) }) : notFound(response);
  }

  if (path === '/drafts' && method === 'POST') {
    const draft = draftOf(body?.message ?? {});

    drafts.set(draft.id, draft);

    return json(response, 200, draft);
  }

  if (path === '/drafts' && method === 'GET') {
    return json(response, 200, { drafts: [...drafts.values()].map(draft => ({ id: draft.id, message: { id: draft.message.id } })) });
  }

  if (path === '/drafts/send' && method === 'POST') {
    const draft = drafts.get(body?.id);

    drafts.delete(body?.id);

    return draft ? json(response, 200, { id: `sent-${draft.id}`, threadId: draft.message.threadId, labelIds: ['SENT'] }) : notFound(response);
  }

  if (one?.[1] === 'drafts') {
    const draft = drafts.get(one[2]);

    if (!draft) {
      return notFound(response);
    }

    if (method === 'PUT') {
      const replaced = { id: draft.id, message: { ...draftOf(body?.message ?? {}).message } };

      drafts.set(draft.id, replaced);

      return json(response, 200, replaced);
    }

    // The draft with its message read as the API gives it: the headers of
    // the raw mail.
    const [head] = Buffer.from(draft.message.raw, 'base64url').toString('utf8').split('\r\n\r\n');
    const lines = head.replace(/\r\n /g, ' ').split('\r\n').map(line => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 2) }));

    return json(response, 200, { id: draft.id, message: { ...draft.message, payload: { headers: lines } } });
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
    const params = new URLSearchParams(await bodyOf(request));
    const refreshToken = params.get('refresh_token') ?? '';

    // The client names itself in the header or in the body.
    const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const client = basic ? decodeURIComponent(Buffer.from(basic, 'base64').toString('utf8').split(':')[0]) : params.get('client_id');

    outsideState.refreshes.push(`${client}:${refreshToken}`);

    if (refreshToken === 'dead-refresh') {
      return json(response, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    }

    const fresh = `fresh-${outsideState.refreshes.length}`;

    // A refresh token of a mailbox opens that mailbox; `stale-refresh`
    // gives a token the API does not let in either.
    if (refreshToken !== 'stale-refresh') {
      outsideState.valid.set(fresh, refreshToken === 'work-refresh' ? 'work@example.com' : 'me@example.com');
    }

    return json(response, 200, { access_token: fresh, token_type: 'Bearer', expires_in: 3600 });
  }

  if (url.pathname.startsWith('/gmail/')) {
    return serveGmail(request, response, url);
  }

  response.writeHead(404).end();
}

// The mail a draft or a send carried: its headers, unfolded, and its text.
function mailOf(raw: string): { headers: Record<string, string>; lines: string[]; body: string } {
  const [head, body] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
  const lines = head.replace(/\r\n /g, ' ').split('\r\n');

  return {
    headers: Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)])),
    lines: head.split('\r\n'),
    body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
}

// A header as its reader sees it: the space between two encoded words is
// not part of the text.
const decodedWords = (value: string) =>
  value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_word, text: string) => Buffer.from(text, 'base64').toString('utf8'));

const requests = (from = 0) => outsideState.api.slice(from).map(request => `${request.method} ${request.url}`);

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
  const { gmailNode } = await import('./gmail.ts');
  const services = await import('./services.ts');

  catalog = buildCatalog({
    summary: 'The tree of the test.',
    children: [connections, gmailNode({ api: `${origin}/gmail`, authorizationServer: origin })],
  }).catalog;
  services.registerServices(catalog);
  port = services.connectionsPort();

  // The OAuth client of the installation, as the operator entered it.
  await prisma.oauthClient.create({ data: { server: 'gmail', clientInformation: { client_id: 'client-1', client_secret: 'secret-1' } } });
});

after(async () => {
  await closeServer(outside);
  await stand.stop();
});

describe('gmail: the access of the account', () => {
  test('the node waits for an account; an account connected before the tree acts on a token renewed where the node says', async () => {
    assert.equal((await grantNow()).vertices.has('gmail'), false);

    // The row of an account as the former path left it: its access token
    // ran out long ago, its refresh token is good.
    await account('default', { access_token: 'old-access', refresh_token: 'good-refresh', obtained_at: aged(7200) }, { identityId: 'me@example.com', identity: { id: 'me@example.com', label: 'me@example.com' } });

    assert.equal((await grantNow()).vertices.has('gmail_search_emails'), true);
    assert.deepEqual((await port.accounts(stand.workspaceId, 'gmail'))[0], { account: 'default', name: 'default', identity: 'me@example.com', status: 'connected' });

    const read = await gmail('get_message', { messageId: 'm3' });

    assert.equal(read.messageId, 'm3');
    assert.deepEqual(outsideState.refreshes, ['client-1:good-refresh']);
    assert.deepEqual(outsideState.api.map(request => request.authorization), ['Bearer fresh-1']);
    assert.equal(((await rowOf('default'))?.tokens as Value).access_token, 'fresh-1');
  });

  test('a token Google refuses is renewed once for all the requests of a call', async () => {
    await account('default', { access_token: 'revoked-access', refresh_token: 'good-refresh' });

    const from = outsideState.api.length;
    const refreshes = outsideState.refreshes.length;
    const found = await gmail('search_emails', { query: 'report' });

    assert.equal(found.messages.length, 2);
    assert.equal(outsideState.refreshes.length, refreshes + 1);

    // The list was refused and asked again; what followed went out on the
    // renewed token at once.
    const sent = outsideState.api.slice(from);
    const fresh = `Bearer fresh-${refreshes + 1}`;

    assert.deepEqual(sent.slice(0, 2).map(request => [request.url.split('?')[0], request.authorization]), [
      ['/messages', 'Bearer revoked-access'],
      ['/messages', fresh],
    ]);
    assert.equal(sent.length, 5);
    assert.ok(sent.slice(2).every(request => request.authorization === fresh));
  });

  test('a renewed token refused all the same, and an authorization that is gone, send the user to authorize again', async () => {
    await account('default', { access_token: 'revoked-access', refresh_token: 'stale-refresh' });
    await refuses(
      gmail('get_message', { messageId: 'm3' }),
      'auth_required',
      /^Gmail refuses the access of the account "default", a renewed token included \(UNAUTHENTICATED: Request had invalid authentication credentials\.\): the user has to authorize the account again\.$/,
    );
    assert.equal((await rowOf('default'))?.status, 'connected');

    await account('default', { access_token: 'revoked-access', refresh_token: 'dead-refresh' });
    await refuses(gmail('get_message', { messageId: 'm3' }), 'auth_required', /^The account "default" of "gmail" can no longer act: the provider no longer honors the refresh token/);
    assert.equal((await rowOf('default'))?.status, 'reauthorization_required');
    assert.equal((await grantNow()).vertices.has('gmail'), false);

    await account('default', { access_token: 'access-1', refresh_token: 'good-refresh' });
  });

  test('who fixes a failed request: the caller, the outside system, nobody', async () => {
    const read = (messageId: string, signal?: AbortSignal) => invoke('gmail_get_message', { account: 'default', messageId }, signal);

    await refuses(read('nomessage'), 'not_found', /^There is no message "nomessage" in the mailbox of the account "default"\.$/);
    await refuses(read('not an id'), 'not_found', /^There is no message "not an id" in the mailbox/);

    outsideState.broken = () => 403;

    const forbidden = await refuses(
      read('m3'),
      'external_error',
      /^Gmail refused the request \(HTTP 403 on GET \/gmail\/messages\/m3\): PERMISSION_DENIED: Gmail API has not been used in project 1 before or it is disabled\. Check that the Gmail API is enabled .* gmail\.readonly and gmail\.compose\.$/,
    );

    assert.deepEqual(forbidden.details, { status: 403 });

    outsideState.broken = () => 500;
    await refuses(read('m3'), 'external_error', /^Gmail refused the request \(HTTP 500 on GET \/gmail\/messages\/m3\): INTERNAL: Backend Error$/);

    outsideState.broken = () => 'drop';
    await refuses(read('m3'), 'unavailable', /^Gmail did not answer: /);

    outsideState.broken = () => 'hang';

    const cancel = new AbortController();
    const cancelled = refuses(read('m3', cancel.signal), 'unavailable', /^The call to Gmail was cancelled before it answered\.$/);

    setTimeout(() => cancel.abort(), 50);
    await cancelled;
    outsideState.broken = null;
  });
});

describe('gmail: reading', () => {
  test('a search gives summaries page by page; a message deleted meanwhile is not in the list', async () => {
    const from = outsideState.api.length;
    const first = await gmail('search_emails', { query: 'from:anna report', limit: 3 });

    assert.deepEqual(first, {
      messages: [
        { messageId: 'm1', threadId: 't1', date: '2026-11-01T10:00:00.000Z', from: 'Anna <anna@example.com>', to: 'me@example.com', subject: 'The report', snippet: 'snippet of m1', labelIds: ['INBOX'] },
        { messageId: 'm2', threadId: 't1', date: '2026-11-01T10:00:00.000Z', from: 'me@example.com', to: 'anna@example.com', subject: 'Re: The report', snippet: 'snippet of m2', labelIds: ['INBOX'] },
      ],
      nextCursor: 'page-2',
      resultSizeEstimate: 4,
    });
    assert.equal(requests(from)[0], 'GET /messages?q=from%3Aanna+report&maxResults=3');
    assert.match(requests(from)[1], /^GET \/messages\/m1\?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject$/);

    const second = await gmail('search_emails', { query: 'from:anna report', cursor: first.nextCursor });

    assert.deepEqual([second.messages.map((found: Value) => [found.messageId, found.subject]), second.nextCursor], [[['m3', null]], null]);
    await refuses(gmail('search_emails', { query: 'x', cursor: 'bogus' }), 'invalid_input', /^cursor is not a nextCursor of this list/);
    await refuses(gmail('search_emails', { query: 'x', cursor: '' }), 'invalid_input', /^cursor is empty/);
    await refuses(gmail('search_emails', { query: 'x', limit: 26 }), 'invalid_input', /limit/);
  });

  test('a message comes with its whole body and the list of its attachments; HTML is read as text', async () => {
    const read = await gmail('get_message', { messageId: 'm1' });

    assert.equal(read.body, LONG_BODY);
    assert.ok(read.body.length > 50_000);
    assert.deepEqual(
      { ...read, body: '' },
      {
        messageId: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        date: '2026-11-01T10:00:00.000Z',
        from: 'Anna <anna@example.com>',
        to: 'me@example.com',
        cc: 'boss@example.com',
        subject: 'The report',
        rfc822MessageId: '<m1@mail.example.com>',
        body: '',
        attachments: [
          { filename: 'report.pdf', partId: '1', mimeType: 'application/pdf', sizeBytes: PDF.length },
          { filename: 'notes.txt', partId: '2', mimeType: 'text/plain', sizeBytes: 5 },
          { filename: 'scan.png', partId: '3', mimeType: 'image/png', sizeBytes: 3 },
          { filename: 'scan.png', partId: '4', mimeType: 'image/png', sizeBytes: 3 },
          { filename: 'empty.zip', partId: '5', mimeType: 'application/zip', sizeBytes: 0 },
        ],
      },
    );

    assert.equal((await gmail('get_message', { messageId: 'm2' })).body, 'Thanks & regards,\nMe ☺\n\nP.S. <soon>');
    assert.deepEqual((({ body, subject, to, attachments }) => ({ body, subject, to, attachments }))(await gmail('get_message', { messageId: 'm3' })), {
      body: '',
      subject: null,
      to: null,
      attachments: [],
    });
  });

  test('a conversation is paged from its newest messages to older ones, each page in the order of the conversation', async () => {
    const ids = (page: Value) => page.messages.map((found: Value) => found.messageId);
    const first = await gmail('get_thread', { threadId: 'long', limit: 2 });

    assert.deepEqual([first.messageCount, ids(first), first.nextCursor], [5, ['p4', 'p5'], 'p4']);
    assert.equal(first.messages[1].body, 'body 5');

    const second = await gmail('get_thread', { threadId: 'long', limit: 2, cursor: first.nextCursor });

    assert.deepEqual([ids(second), second.nextCursor], [['p2', 'p3'], 'p2']);

    // A message that arrived meanwhile does not move the pages already read.
    outsideState.messages.set('p6', message('p6', 'long', { Subject: 'Part 6' }, []));
    outsideState.threads.get('long')?.push('p6');

    const third = await gmail('get_thread', { threadId: 'long', limit: 2, cursor: second.nextCursor });

    assert.deepEqual([third.messageCount, ids(third), third.nextCursor], [6, ['p1'], null]);

    const whole = await gmail('get_thread', { threadId: 't1' });

    assert.deepEqual([whole.messageCount, ids(whole), whole.nextCursor], [2, ['m1', 'm2'], null]);
    assert.equal(whole.messages[0].body, LONG_BODY);
    await refuses(gmail('get_thread', { threadId: 'long', cursor: 'm1' }), 'invalid_input', /^cursor is not a nextCursor of the conversation "long"/);
    await refuses(gmail('get_thread', { threadId: 'nothread' }), 'not_found', /^There is no conversation "nothread" in the mailbox of the account "default"\.$/);
  });

  test('an attachment lands in storage as a file: bytes that came with the message, or by their id', async () => {
    const stored = async (fileId: string) => Buffer.from(await new Response(await files.openFileContent(fileId)).arrayBuffer());
    const report = await gmail('get_attachment', { messageId: 'm1', filename: 'report.pdf' });

    assert.deepEqual({ ...report, id: '' }, { kind: 'file', id: '', name: 'report.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, width: null, height: null });
    assert.deepEqual(await stored(report.id), PDF);
    assert.equal((await files.getWorkspaceFile(stand.workspaceId, report.id)).scope, 'gmail');
    assert.equal(outsideState.api.at(-1)?.url, '/messages/m1/attachments/att-1');

    const notes = await gmail('get_attachment', { messageId: 'm1', filename: 'notes.txt' });

    assert.equal((await stored(notes.id)).toString(), 'notes');
    assert.equal((await stored((await gmail('get_attachment', { messageId: 'm1', filename: 'scan.png', partId: '4' })).id)).toString(), 'two');

    const shared = await refuses(
      gmail('get_attachment', { messageId: 'm1', filename: 'scan.png' }),
      'invalid_input',
      /^The message "m1" has 2 attachments named "scan\.png": pass partId, one of "3", "4"\.$/,
    );

    assert.deepEqual(shared.details, { partIds: ['3', '4'] });

    const missing = await refuses(
      gmail('get_attachment', { messageId: 'm1', filename: 'report.pdf', partId: '2' }),
      'not_found',
      /^The message "m1" has no attachment "report\.pdf" with partId "2"\. Its attachments: "report\.pdf" \(partId "1"\), /,
    );

    assert.equal((missing.details as Value).attachments.length, 5);
    await refuses(gmail('get_attachment', { messageId: 'm3', filename: 'a.txt' }), 'not_found', /^The message "m3" has no attachment "a\.txt"\. It has no attachments\.$/);
    await refuses(gmail('get_attachment', { messageId: 'nomessage', filename: 'a.txt' }), 'not_found', /^There is no message "nomessage"/);
    await refuses(
      gmail('get_attachment', { messageId: 'm1', filename: 'empty.zip' }),
      'external_error',
      /^Gmail returned no content for the attachment "empty\.zip" of the message "m1"\.$/,
    );
  });
});

describe('gmail: drafts and sending', () => {
  test('a draft is a plain-text mail: its recipients, its subject and its text go out as they were given', async () => {
    const draft = await gmail('create_draft', {
      to: ['Анна Петрова <anna@example.com>', 'bob@example.com'],
      cc: ['boss@example.com'],
      bcc: ['archive@example.com'],
      subject: 'Отчёт за ноябрь: итоги, планы и всё, что нужно обсудить на встрече в четверг',
      body: 'Привет!\n\nВот отчёт. — Я',
    });

    assert.deepEqual(draft, { draftId: 'd1', messageId: 'dm1', threadId: 'dt1' });

    const sent = outsideState.api.at(-1);
    const mail = mailOf(sent?.body?.message.raw);

    assert.deepEqual([sent?.method, sent?.url, Object.keys(sent?.body?.message)], ['POST', '/drafts', ['raw']]);
    assert.equal(decodedWords(mail.headers.To), 'Анна Петрова <anna@example.com>, bob@example.com');
    assert.match(mail.headers.To, /^=\?UTF-8\?B\?[^?]+\?= <anna@example\.com>, bob@example\.com$/);
    assert.deepEqual([mail.headers.Cc, mail.headers.Bcc], ['boss@example.com', 'archive@example.com']);
    assert.equal(decodedWords(mail.headers.Subject), 'Отчёт за ноябрь: итоги, планы и всё, что нужно обсудить на встрече в четверг');
    assert.ok(mail.lines.every(line => line.length <= 76), `no header line is longer than a line of mail: ${mail.lines.join(' | ')}`);
    assert.ok(mail.lines.filter(line => line.startsWith(' =?UTF-8?B?')).length >= 2, 'a long subject takes several encoded words');
    assert.equal(mail.headers['Content-Type'], 'text/plain; charset="UTF-8"');
    assert.equal(mail.body, 'Привет!\n\nВот отчёт. — Я');
    assert.equal(mail.headers['In-Reply-To'], undefined);
  });

  test('a reply joins the conversation of the mail it answers and takes its subject', async () => {
    const from = outsideState.api.length;
    const draft = await gmail('create_draft', { to: ['anna@example.com'], body: 'Got it.', replyToMessageId: 'm1' });

    assert.deepEqual(draft, { draftId: 'd2', messageId: 'dm2', threadId: 't1' });
    assert.deepEqual(requests(from), [
      'GET /messages/m1?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References',
      'POST /drafts',
    ]);

    const posted = outsideState.api.at(-1)?.body?.message;
    const mail = mailOf(posted.raw);

    assert.equal(posted.threadId, 't1');
    assert.deepEqual(
      [mail.headers.Subject, mail.headers['In-Reply-To'], mail.headers.References],
      ['Re: The report', '<m1@mail.example.com>', '<m0@mail.example.com> <m1@mail.example.com>'],
    );

    // A subject of the call's own stands; "Re:" is not put twice.
    await gmail('update_draft', { draftId: 'd2', to: ['anna@example.com'], subject: 'Another matter', body: 'x', replyToMessageId: 'm2' });
    assert.equal(mailOf(outsideState.api.at(-1)?.body?.message.raw).headers.Subject, 'Another matter');
    await gmail('update_draft', { draftId: 'd2', to: ['anna@example.com'], body: 'x', replyToMessageId: 'm2' });
    assert.equal(mailOf(outsideState.api.at(-1)?.body?.message.raw).headers.Subject, 'Re: The report');
    assert.deepEqual([outsideState.api.at(-1)?.method, outsideState.api.at(-1)?.url], ['PUT', '/drafts/d2']);
  });

  test('what the call gets wrong is refused before anything is written', async () => {
    const from = outsideState.api.length;
    const draft = (input: JsonObject) => gmail('create_draft', { to: ['anna@example.com'], body: 'x', ...input });

    await refuses(draft({}), 'invalid_input', /^subject is required for a mail that is not a reply\.$/);
    await refuses(draft({ subject: '  ' }), 'invalid_input', /^subject is blank/);
    await refuses(draft({ subject: 'x', to: [] }), 'invalid_input', /to/);
    await refuses(draft({ subject: 'x', cc: ['eve@example.com\r\nBcc: spy@example.com'] }), 'invalid_input', /^cc holds an address with a control character/);
    await refuses(draft({ subject: 'x', bcc: [' '] }), 'invalid_input', /^bcc holds an empty address/);
    assert.deepEqual(requests(from), []);

    await refuses(draft({ replyToMessageId: 'm3' }), 'invalid_input', /^subject is required: the message "m3" has no subject to take\.$/);
    await refuses(draft({ replyToMessageId: 'nomessage' }), 'not_found', /^There is no message "nomessage" \(replyToMessageId\) in the mailbox of the account "default"\.$/);
    await refuses(gmail('update_draft', { draftId: 'nodraft', to: ['anna@example.com'], subject: 'x', body: 'x' }), 'not_found', /^There is no draft "nodraft" in the mailbox/);
    await refuses(gmail('send_draft', { draftId: 'nodraft' }), 'not_found', /^There is no draft "nodraft" in the mailbox/);
    assert.ok(requests(from).every(request => !request.startsWith('POST /drafts ') && request !== 'POST /messages/send'));
    assert.equal(outsideState.drafts.size, 2);
  });

  test('the drafts are listed with what they say; a draft is sent as it is, a mail — at once', async () => {
    const list = await gmail('list_drafts');

    assert.deepEqual(list.nextCursor, null);
    assert.deepEqual(list.drafts.map((draft: Value) => [draft.draftId, draft.threadId, draft.to, draft.subject]), [
      ['d1', 'dt1', '=?UTF-8?B?0JDQvdC90LAg0J/QtdGC0YDQvtCy0LA=?= <anna@example.com>, bob@example.com', list.drafts[0].subject],
      ['d2', 't1', 'anna@example.com', 'Re: The report'],
    ]);
    assert.match(list.drafts[1].messageId, /^dm\d+$/);

    assert.deepEqual(await gmail('send_draft', { draftId: 'd2' }), { messageId: 'sent-d2', threadId: 't1' });
    assert.deepEqual(outsideState.api.at(-1)?.body, { id: 'd2' });
    assert.equal((await gmail('list_drafts')).drafts.length, 1);

    assert.deepEqual(await gmail('send_email', { to: ['anna@example.com'], subject: 'Hello', body: 'Hi' }), { messageId: 'sent-mail', threadId: 'new-thread' });
    assert.deepEqual(await gmail('send_email', { to: ['anna@example.com'], body: 'Hi', replyToMessageId: 'm2' }), { messageId: 'sent-mail', threadId: 't1' });

    const sent = outsideState.api.at(-1);

    assert.deepEqual([sent?.method, sent?.url, sent?.body?.threadId], ['POST', '/messages/send', 't1']);
    assert.equal(mailOf(sent?.body?.raw).headers['In-Reply-To'], '<m2@mail.example.com>');
  });
});

describe('gmail: one more account', () => {
  test('an account whose identity nobody recorded is asked who it is, on a renewed access, before another one is added', async () => {
    const authorize = () => invoke('connections_authorize', { service: 'gmail', name: 'Work' });

    // The row of an account connected before identities were kept: no
    // identity, and an access token that ran out.
    await account('default', { access_token: 'old-access', refresh_token: 'good-refresh', obtained_at: aged(7200) }, { identityId: null, identity: null });

    // The provider does not say who the account is: no twin can be told,
    // so no second account yet.
    outsideState.broken = path => (path === '/profile' ? 500 : null);
    await refuses(
      authorize(),
      'conflict',
      /^Cannot add another "gmail" account yet: the identity of account "default" is unknown \(identity probe answered 500\)\. Retry once the reason is gone, or re-authorize that account first\.$/,
    );
    outsideState.broken = null;

    // A token the provider no longer takes is renewed for the question too.
    await account('default', { access_token: 'revoked-access', refresh_token: 'good-refresh' }, { identityId: null, identity: null });

    const from = outsideState.api.length;
    const link = await authorize();

    assert.deepEqual(link.account, { account: 'work', name: 'Work', identity: null, status: 'pending' });
    assert.deepEqual(outsideState.api.slice(from).map(request => [request.url, request.authorization === 'Bearer revoked-access']), [
      ['/profile', true],
      ['/profile', false],
    ]);
    assert.equal((await rowOf('default'))?.identityId, 'me@example.com');
    assert.deepEqual(
      (await port.accounts(stand.workspaceId, 'gmail')).map(found => [found.account, found.identity, found.status]),
      [
        ['default', 'me@example.com', 'connected'],
        ['work', null, 'pending'],
      ],
    );
  });

  test('each account acts on its own access', async () => {
    await account('work', { access_token: 'work-old', refresh_token: 'work-refresh', obtained_at: aged(7200) }, { displayName: 'Work' });

    const from = outsideState.api.length;

    await invoke('gmail_get_message', { account: 'work', messageId: 'm3' });
    await invoke('gmail_get_message', { account: 'default', messageId: 'm3' });

    const [work, home] = outsideState.api.slice(from).map(request => request.authorization?.replace('Bearer ', '') ?? '');

    assert.deepEqual([outsideState.valid.get(work), outsideState.valid.get(home)], ['work@example.com', 'me@example.com']);
    await refuses(invoke('gmail_get_message', { messageId: 'm3' }), 'invalid_input', /account/);
  });
});
