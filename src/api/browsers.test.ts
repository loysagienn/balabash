// The linked browsers over the stand (src/test-support/stand.ts) and a
// server of its own that carries the hub (src/browser-link): the console
// asks for a pairing code, a client that plays the extension
// (src/browser-link/test-client.ts) brings it in a `hello`, and from then on
// the browser is the user's — listed, renamed, enabled, disabled,
// disconnected through /api/browsers, each change told to the open consoles
// by the `browsers` frame. The agents of a workspace reach the browsers
// enabled in it and lose their sessions the moment a browser stops being so.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { STAND_HOST, closeServer, listen, sessionCookie, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import { CLOSE_SESSION_REVOKED, CLOSE_UNAUTHORIZED, SESSIONS_SINCE_VERSION } from '../browser-link/protocol.ts';
import type { WelcomeParams } from '../browser-link/protocol.ts';
import { dial, hello, openSessionLink } from '../browser-link/test-client.ts';
import type { TestLink } from '../browser-link/test-client.ts';
import type { ApiErrorBody, BrowserPairingResponse, BrowserResponse, BrowsersResponse } from './contract.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let createAuthCode: typeof import('./auth-codes.ts')['createAuthCode'];
let browserLink: typeof import('../browser-link/index.ts');
let linkServer: http.Server;
let linkPort: number;
let stopLink: () => void;

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ createAuthCode } = await import('./auth-codes.ts'));

  browserLink = await import('../browser-link/index.ts');
  linkServer = http.createServer((_request, response) => response.writeHead(404).end());
  stopLink = browserLink.startBrowserLink(linkServer);
  linkPort = (await listen(linkServer, 0, '127.0.0.1')).port;
});

after(async () => {
  stopLink();
  await closeServer(linkServer);
  await stand.stop();
});

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

// A session of another user in a workspace (the operator's unless named).
async function signIn(displayName: string, workspaceId = stand.workspaceId): Promise<{ userId: string; cookie: string }> {
  const userId = (await prisma.user.create({ data: { displayName } })).id;
  const reply = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId, userId }, 'telegram') }, cookie: null });

  assert.equal(reply.status, 200, reply.text);

  return { userId, cookie: sessionCookie(reply.headers['set-cookie'] ?? []) };
}

async function list(cookie?: string): Promise<BrowsersResponse> {
  const reply = await stand.request('GET', '/api/browsers', cookie ? { cookie } : {});

  assert.equal(reply.status, 200, reply.text);

  return reply.json<BrowsersResponse>();
}

// Pairs a browser the way the console and the extension do it together.
// `extensionVersion` — what the extension says it is; an old one by default.
async function pair(name: string, cookie?: string, extensionVersion?: string): Promise<{ link: TestLink; welcome: WelcomeParams }> {
  const asked = await stand.request('POST', '/api/browsers/pairings', { body: { name }, ...(cookie ? { cookie } : {}) });

  assert.equal(asked.status, 200, asked.text);

  const link = await dial(linkPort, { host: STAND_HOST });

  link.send(hello({ pairingCode: asked.json<BrowserPairingResponse>().code }, extensionVersion));

  const welcome = await link.next();

  assert.equal(welcome.method, 'welcome');

  return { link, welcome: welcome.params as WelcomeParams };
}

async function reconnect(secret: string): Promise<TestLink> {
  const link = await dial(linkPort, { host: STAND_HOST });

  link.send(hello({ secret }));
  assert.equal((await link.next()).method, 'welcome');

  return link;
}

// Opens an event stream and resolves once `count` frames `browsers` arrived.
function browsersFrames(cookie: string, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: stand.port, path: '/api/events/stream?after=0', headers: { host: STAND_HOST, 'x-forwarded-proto': 'https', cookie } }, res => {
      let text = '';
      let frames = 0;

      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;

        const blocks = text.split('\n\n');

        text = blocks.pop() ?? '';
        frames += blocks.filter(block => block.split('\n').includes('event: browsers')).length;

        if (frames >= count) {
          req.destroy();
          resolve(frames);
        }
      });
    });

    req.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        reject(error);
      }
    });
    req.end();
  });
}

describe('pairing a browser', () => {
  test('the code of the console makes the browser the user’s, enabled in the workspace, on the link — and the secret brings it back', async () => {
    const before = await list();

    assert.deepEqual(before.browsers, []);
    assert.equal(before.extension.id, 'moadcglcgjkicomjkmccjfckhoeohhck');
    assert.equal(before.extension.version, null, 'the stand has built no extension');
    assert.equal(before.extension.size, null, 'and so has no archive to weigh');

    const { link, welcome } = await pair('MacBook');

    assert.equal(welcome.name, 'MacBook');
    assert.ok(welcome.secret, 'a pairing hands the secret out');
    await settle();

    const [browser] = (await list()).browsers;

    assert.equal(browser?.id, welcome.browserId);
    assert.deepEqual(
      { name: browser?.name, online: browser?.online, enabledHere: browser?.enabledHere, extensionVersion: browser?.extensionVersion, outdated: browser?.outdated },
      { name: 'MacBook', online: true, enabledHere: true, extensionVersion: '0.2.0', outdated: false },
    );
    assert.ok(browser?.lastSeenAt);

    link.close();
    await link.closed;
    await settle();
    assert.equal((await list()).browsers[0]?.online, false);

    const again = await reconnect(welcome.secret!);

    await settle();
    assert.equal((await list()).browsers[0]?.online, true);
    again.close();
    await again.closed;
  });

  test('a code works once; a name the user has, an empty one and a body without one are refused', async () => {
    const asked = await stand.request('POST', '/api/browsers/pairings', { body: { name: 'Once' } });
    const { code } = asked.json<BrowserPairingResponse>();
    const first = await dial(linkPort, { host: STAND_HOST });

    first.send(hello({ pairingCode: code }));
    assert.equal((await first.next()).method, 'welcome');

    const second = await dial(linkPort, { host: STAND_HOST });

    second.send(hello({ pairingCode: code }));
    assert.equal((await second.closed).code, CLOSE_UNAUTHORIZED);
    first.close();
    await first.closed;

    const taken = await stand.request('POST', '/api/browsers/pairings', { body: { name: 'Once' } });

    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.json<ApiErrorBody>().error.code, 'name_taken');

    for (const body of [{ name: '  ' }, {}]) {
      const refused = await stand.request('POST', '/api/browsers/pairings', { body });

      assert.equal(refused.status, 400, refused.text);
      assert.equal(refused.json<ApiErrorBody>().error.code, 'invalid_name');
    }
  });

  test('needs a session', async () => {
    assert.equal((await stand.request('POST', '/api/browsers/pairings', { body: { name: 'Nobody' }, cookie: null })).status, 401);
    assert.equal((await stand.request('GET', '/api/browsers', { cookie: null })).status, 401);
    assert.equal((await stand.request('GET', '/api/browsers/extension.zip', { cookie: null })).status, 401);
  });
});

describe('a paired browser', () => {
  test('is renamed by its owner — the extension hears the name; disabled and enabled in the workspace; another user sees it only while enabled and changes nothing', async () => {
    const { link, welcome } = await pair('Shared');
    const id = welcome.browserId;
    const guest = await signIn('Guest');

    assert.deepEqual(
      (await list(guest.cookie)).others.filter(browser => browser.id === id).map(browser => [browser.name, browser.ownerName, browser.online]),
      [['Shared', 'Operator', true]],
    );
    assert.ok((await list(guest.cookie)).others.find(browser => browser.id === id)?.lastSeenAt, 'with when it was last on the link');
    assert.deepEqual((await list(guest.cookie)).browsers, [], 'not theirs');

    for (const [method, path, body] of [
      ['PATCH', `/api/browsers/${id}`, { name: 'Taken over' }],
      ['PUT', `/api/browsers/${id}/workspace`, undefined],
      ['DELETE', `/api/browsers/${id}/workspace`, undefined],
      ['DELETE', `/api/browsers/${id}`, undefined],
    ] as const) {
      const refused = await stand.request(method, path, { cookie: guest.cookie, ...(body ? { body } : {}) });

      assert.equal(refused.status, 404, `${method} ${path}: ${refused.text}`);
    }

    const renamed = await stand.request('PATCH', `/api/browsers/${id}`, { body: { name: 'Shared laptop' } });

    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json<BrowserResponse>().browser.name, 'Shared laptop');
    assert.deepEqual(await link.next(), { method: 'browser.updated', params: { name: 'Shared laptop' } });

    const disabled = await stand.request('DELETE', `/api/browsers/${id}/workspace`);

    assert.equal(disabled.json<BrowserResponse>().browser.enabledHere, false);
    assert.deepEqual((await list(guest.cookie)).others.filter(browser => browser.id === id), [], 'a disabled browser is not seen by others');
    assert.equal((await list()).browsers.find(browser => browser.id === id)?.enabledHere, false, 'the owner still has it');

    const enabled = await stand.request('PUT', `/api/browsers/${id}/workspace`);

    assert.equal(enabled.json<BrowserResponse>().browser.enabledHere, true);
    assert.equal((await list(guest.cookie)).others.some(browser => browser.id === id), true);

    link.close();
    await link.closed;
  });

  test('that was disconnected is gone: its link closes for good and its secret is nobody’s', async () => {
    const { link, welcome } = await pair('Leaving');
    const removed = await stand.request('DELETE', `/api/browsers/${welcome.browserId}`);

    assert.equal(removed.status, 200, removed.text);
    assert.equal((await link.closed).code, CLOSE_UNAUTHORIZED);
    assert.equal((await list()).browsers.some(browser => browser.id === welcome.browserId), false);

    const back = await dial(linkPort, { host: STAND_HOST });

    back.send(hello({ secret: welcome.secret! }));
    assert.equal((await back.closed).code, CLOSE_UNAUTHORIZED);
  });

  test('pairing again with the secret it had replaces the browser instead of adding one', async () => {
    const first = await pair('Replaced');

    first.link.close();
    await first.link.closed;

    const asked = await stand.request('POST', '/api/browsers/pairings', { body: { name: 'Replacement' } });
    const link = await dial(linkPort, { host: STAND_HOST });

    link.send(hello({ pairingCode: asked.json<BrowserPairingResponse>().code, previousSecret: first.welcome.secret! }));

    const welcome = (await link.next()).params as WelcomeParams;
    const names = (await list()).browsers.map(browser => browser.name);

    assert.notEqual(welcome.browserId, first.welcome.browserId);
    assert.ok(names.includes('Replacement') && !names.includes('Replaced'), names.join(', '));

    link.close();
    await link.closed;
  });
});

describe('the open consoles', () => {
  test('of the owner and of the workspace hear that the list changed — on a pairing, a link coming and going, a rename', async () => {
    const guest = await signIn('Watcher');
    // The pairing (the browser connected), the rename, the link gone.
    const owner = browsersFrames(stand.cookie, 3);
    const watcher = browsersFrames(guest.cookie, 3);

    await settle();

    const { link, welcome } = await pair('Watched');

    await settle();
    await stand.request('PATCH', `/api/browsers/${welcome.browserId}`, { body: { name: 'Watched closely' } });
    await settle();
    link.close();
    await link.closed;

    assert.ok((await owner) >= 3);
    assert.ok((await watcher) >= 3);
  });

  test('of a workspace the browser was enabled in hear that it is gone when it is paired again from another workspace', async () => {
    const elsewhere = (await prisma.workspace.create({ data: { workspaceName: 'Paired again elsewhere' } })).id;
    const mover = await signIn('Mover');
    const moved = await stand.request('POST', '/api/auth', {
      body: { code: createAuthCode({ workspaceId: elsewhere, userId: mover.userId }, 'telegram') },
      cookie: null,
    });
    const first = await pair('Moved', mover.cookie);

    first.link.close();
    await first.link.closed;
    await settle();

    // The operator does not own the browser: only its workspace tells their console.
    let heard = 0;

    void browsersFrames(stand.cookie, 1).then(count => {
      heard = count;
    });
    await settle();

    const asked = await stand.request('POST', '/api/browsers/pairings', { body: { name: 'Moved again' }, cookie: sessionCookie(moved.headers['set-cookie'] ?? []) });

    assert.equal(asked.status, 200, asked.text);

    const link = await dial(linkPort, { host: STAND_HOST });

    link.send(hello({ pairingCode: asked.json<BrowserPairingResponse>().code, previousSecret: first.welcome.secret! }));
    assert.equal((await link.next()).method, 'welcome');
    await settle();
    assert.equal(heard, 1, 'the console of the workspace the replaced browser was enabled in');
    assert.equal((await list()).browsers.some(browser => browser.name === 'Moved'), false);
    link.close();
    await link.closed;
  });

  test('of another workspace hear nothing of it', async () => {
    const elsewhere = (await prisma.workspace.create({ data: { workspaceName: 'Elsewhere' } })).id;
    const stranger = await signIn('Stranger', elsewhere);
    let heard = 0;

    void browsersFrames(stranger.cookie, 1).then(count => {
      heard = count;
    });
    await settle();

    const { link } = await pair('Unheard');

    link.close();
    await link.closed;
    await settle();
    assert.equal(heard, 0);
  });
});

describe('the agents of a workspace', () => {
  const session = (browserId: string, workspaceId = stand.workspaceId) =>
    browserLink.openBrowserSession({ workspaceId, browserId, clientName: 'test', label: 'Workspace — Thread' });
  const refusedAs = (code: string) => (error: unknown) => error instanceof browserLink.BrowserAccessError && error.code === code;

  test('see the browsers enabled in it — whoever owns them, connected or not — and none of another workspace', async () => {
    const elsewhere = (await prisma.workspace.create({ data: { workspaceName: 'Agents elsewhere' } })).id;
    const colleague = await signIn('Colleague');
    const mine = await pair('Agent’s own', undefined, SESSIONS_SINCE_VERSION);
    const theirs = await pair('Agent’s colleague', colleague.cookie, SESSIONS_SINCE_VERSION);

    theirs.link.close();
    await theirs.link.closed;
    await settle();

    const seen = new Map((await browserLink.workspaceBrowsers(stand.workspaceId)).map(browser => [browser.id, browser]));

    assert.equal(seen.get(mine.welcome.browserId)?.connected, true);
    assert.deepEqual(
      [seen.get(theirs.welcome.browserId)?.ownerName, seen.get(theirs.welcome.browserId)?.connected],
      ['Colleague', false],
    );
    assert.deepEqual(await browserLink.workspaceBrowsers(elsewhere), []);

    // A browser of another workspace does not exist to the agents of this one.
    await assert.rejects(session(mine.welcome.browserId, elsewhere), refusedAs('not_enabled'));
    await assert.rejects(browserLink.workspaceBrowserTabs(elsewhere, mine.welcome.browserId), refusedAs('not_enabled'));
    await assert.rejects(session(theirs.welcome.browserId), refusedAs('offline'));

    mine.link.close();
    await mine.link.closed;
  });

  test('get neither the tabs of a browser whose extension is older than the one that holds every boundary, nor a session in it', async () => {
    const { link, welcome } = await pair('Agent’s old extension', undefined, '0.5.0');
    const seen = (await browserLink.workspaceBrowsers(stand.workspaceId)).find(browser => browser.id === welcome.browserId);

    assert.equal(seen?.connected, true, 'the browser is linked and listed all the same');
    await assert.rejects(browserLink.workspaceBrowserTabs(stand.workspaceId, welcome.browserId), refusedAs('outdated'));
    await assert.rejects(session(welcome.browserId), refusedAs('outdated'));
    link.close();
    await link.closed;
  });

  test('lose a session when its browser is disabled in the workspace, and every session when it is disconnected', async () => {
    const elsewhere = (await prisma.workspace.create({ data: { workspaceName: 'Sessions elsewhere' } })).id;
    const { link, welcome } = await pair('Agent’s sessions', undefined, SESSIONS_SINCE_VERSION);
    const id = welcome.browserId;

    await prisma.userBrowserWorkspace.create({ data: { browserId: id, workspaceId: elsewhere } });

    let opening = session(id);
    const here = await openSessionLink(linkPort, STAND_HOST, link, 1);
    const opened = await opening;

    assert.match(opened.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/cdp\//);
    opening = session(id, elsewhere);

    const there = await openSessionLink(linkPort, STAND_HOST, link, 2);
    const openedElsewhere = await opening;

    assert.equal((await stand.request('DELETE', `/api/browsers/${id}/workspace`)).status, 200);
    assert.equal((await here.closed).code, CLOSE_SESSION_REVOKED);
    assert.equal((await opened.ended).end, 'revoked');
    await assert.rejects(session(id), refusedAs('not_enabled'));

    // The session of the workspace where the browser stays enabled lives on.
    await settle();
    there.send({ method: 'chrome.tabs.onCreated', params: [{ id: 1 }] });

    assert.equal((await stand.request('DELETE', `/api/browsers/${id}`)).status, 200);
    assert.equal((await there.closed).code, CLOSE_SESSION_REVOKED);
    assert.equal((await openedElsewhere.ended).end, 'revoked');
    assert.equal((await link.closed).code, CLOSE_UNAUTHORIZED);
  });
});
