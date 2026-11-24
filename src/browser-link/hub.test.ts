// The hub of the browser links (hub.ts) with a client that plays the
// extension (test-client.ts): which upgrade requests become links, who a
// `hello` makes a connected browser, how a link ends, and the sessions the
// server opens in a browser — the ticket of a session link and how the end
// of a session is told.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBrowserLinkHub } from './hub.ts';
import type { Admission, BrowserLinkHub } from './hub.ts';
import { CLOSE_SESSION_REVOKED, CLOSE_SESSION_STOPPED, CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_PROTOCOL, SESSION_PATH } from './protocol.ts';
import type { HelloParams, WelcomeParams } from './protocol.ts';
import { EXTENSION_ORIGIN, dial, hello, openSessionLink } from './test-client.ts';

const HOST = 'console.test';

let server: http.Server;
let port: number;
let hub: BrowserLinkHub;
let admitted: HelloParams[] = [];
let presence: [string, boolean][] = [];

// The secret `known` is the browser b1; the code `fresh` pairs the browser b2.
async function admit(params: HelloParams): Promise<Admission | null> {
  admitted.push(params);

  if ('pairingCode' in params) {
    return params.pairingCode === 'fresh' ? { browserId: 'b2', name: 'Paired', secret: 'secret-of-b2' } : null;
  }

  return params.secret === 'known' ? { browserId: 'b1', name: 'Known' } : null;
}

before(async () => {
  hub = createBrowserLinkHub({
    admit,
    extensionVersion: async () => '0.9.0',
    host: HOST,
    origin: EXTENSION_ORIGIN,
    idleTimeoutMs: 300,
    pingIntervalMs: 100,
  });
  hub.onPresence = (browserId, connected) => presence.push([browserId, connected]);
  server = http.createServer((_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => {
    if (!hub.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  hub.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function connectKnown() {
  const link = await dial(port, { host: HOST });

  link.send(hello({ secret: 'known' }));
  assert.equal((await link.next()).method, 'welcome');

  return link;
}

describe('an upgrade request', () => {
  test('becomes a link only on the control path, for the console host, from the extension', async () => {
    await assert.rejects(dial(port, { host: 'elsewhere.test' }), /HTTP 403/);
    await assert.rejects(dial(port, { host: HOST, origin: 'https://console.test' }), /HTTP 403/);
    await assert.rejects(dial(port, { host: HOST, origin: null }), /HTTP 403/);
    // A session link needs a ticket the server has just handed out.
    await assert.rejects(dial(port, { host: HOST, path: SESSION_PATH }), /HTTP 403/);
    await assert.rejects(dial(port, { host: HOST, path: `${SESSION_PATH}?ticket=made-up` }), /HTTP 403/);
    // Not the hub's path: the owner of the server drops it.
    await assert.rejects(dial(port, { host: HOST, path: '/browser-link/other' }));

    (await dial(port, { host: HOST })).close();
  });
});

describe('a hello', () => {
  test('with a known secret makes the browser connected; the welcome names it and the extension the server builds', async () => {
    presence = [];

    const link = await dial(port, { host: HOST });

    link.send(hello({ secret: 'known' }, '0.2.0'));

    const welcome = await link.next();

    assert.equal(welcome.method, 'welcome');
    assert.deepEqual(welcome.params, { browserId: 'b1', name: 'Known', currentExtensionVersion: '0.9.0' } satisfies WelcomeParams);
    assert.equal(hub.browser('b1')?.extensionVersion, '0.2.0');
    assert.deepEqual(presence, [['b1', true]]);

    link.close();
    await link.closed;
    await settle();
    assert.equal(hub.browser('b1'), null);
    assert.deepEqual(presence, [['b1', true], ['b1', false]]);
  });

  test('with a pairing code brings the secret back, once, and hands the previous secret to whoever admits', async () => {
    admitted = [];

    const link = await dial(port, { host: HOST });

    link.send(hello({ pairingCode: 'fresh', previousSecret: 'old' }));
    assert.deepEqual((await link.next()).params, { browserId: 'b2', name: 'Paired', currentExtensionVersion: '0.9.0', secret: 'secret-of-b2' });
    assert.deepEqual(admitted, [{ protocol: 1, extensionVersion: '0.2.0', pairingCode: 'fresh', previousSecret: 'old' }]);
    link.close();
    await link.closed;
  });

  test('of nobody — an unknown secret, a refused code, no identity at all — closes the link as unauthorized', async () => {
    for (const frame of [hello({ secret: 'unknown' }), hello({ pairingCode: 'stale' }), { method: 'hello', params: { protocol: 1 } }, { method: 'hello' }]) {
      const link = await dial(port, { host: HOST });

      link.send(frame);
      assert.equal((await link.closed).code, CLOSE_UNAUTHORIZED, JSON.stringify(frame));
    }
  });

  test('of another wire version closes the link as unsupported, whoever it is', async () => {
    const link = await dial(port, { host: HOST });

    link.send({ method: 'hello', params: { protocol: 99, extensionVersion: '9.0.0', secret: 'known' } });
    assert.equal((await link.closed).code, CLOSE_UNSUPPORTED_PROTOCOL);
    assert.equal(hub.browser('b1'), null);
  });
});

describe('a connected browser', () => {
  test('answers the server’s requests; a refusal carries its code', async () => {
    const link = await connectKnown();
    const tabs = hub.browser('b1')!.listTabs();
    const request = await link.next();

    assert.equal(request.method, 'tabs.list');
    link.send({ id: request.id, result: { tabs: [{ id: 7, windowId: 1, groupId: -1, title: 'Inbox', url: 'https://mail.test/', active: true, owned: false, debuggable: true }] } });
    assert.deepEqual((await tabs).map(tab => tab.title), ['Inbox']);

    const refused = hub.browser('b1')!.listTabs();

    link.send({ id: (await link.next()).id, error: 'The user hid the list', code: 'tabs_hidden' });
    await assert.rejects(refused, (error: unknown) => (error as { code?: string }).code === 'tabs_hidden');

    link.close();
    await link.closed;
  });

  test('is replaced by its own new link, and stays connected through it', async () => {
    const first = await connectKnown();

    presence = [];

    const second = await connectKnown();

    assert.equal((await first.closed).code, 1000);
    await settle();
    assert.ok(hub.browser('b1'), 'the new link holds the browser');
    assert.deepEqual(presence, [['b1', true]], 'the old link going away is not the browser going away');

    second.close();
    await second.closed;
  });

  test('hears its new name', async () => {
    const link = await connectKnown();

    hub.renamed('b1', 'Renamed');
    assert.deepEqual(await link.next(), { method: 'browser.updated', params: { name: 'Renamed' } });

    link.close();
    await link.closed;
  });

  test('that was revoked is gone at once and its link closes as unauthorized', async () => {
    const link = await connectKnown();

    hub.revoke('b1');
    assert.equal(hub.browser('b1'), null);
    assert.equal((await link.closed).code, CLOSE_UNAUTHORIZED);
  });

  test('that keeps silent is dropped; one that pings stays', async () => {
    const silent = await connectKnown();

    await silent.closed;
    await settle();
    assert.equal(hub.browser('b1'), null);

    const talking = await connectKnown();
    const pings = setInterval(() => talking.send({ method: 'ping' }), 100);

    await new Promise(resolve => setTimeout(resolve, 700));
    clearInterval(pings);
    assert.ok(hub.browser('b1'), 'pings keep the link');

    talking.close();
    await talking.closed;
  });
});

// The control link of b1 that keeps talking, as the extension's does.
async function connectTalking() {
  const link = await connectKnown();
  const pings = setInterval(() => link.send({ method: 'ping' }), 100);

  return {
    link,
    async close() {
      clearInterval(pings);
      link.close();
      await link.closed;
    },
  };
}

describe('a session', () => {
  test('is the link the extension dials with the ticket of session.open; commands go one way, events the other', async () => {
    const control = await connectTalking();
    const opening = hub.browser('b1')!.openSession({ clientName: 'test', label: 'Workspace — Thread' });
    const request = await control.link.next();

    assert.equal(request.method, 'session.open');

    const { ticket, clientName, label } = request.params as { ticket: string; clientName: string; label: string };

    assert.deepEqual([clientName, label], ['test', 'Workspace — Thread']);

    const link = await dial(port, { host: HOST, path: `${SESSION_PATH}?ticket=${ticket}` });

    // The ticket is good for one link.
    await assert.rejects(dial(port, { host: HOST, path: `${SESSION_PATH}?ticket=${ticket}` }), /HTTP 403/);

    // The first tab is announced before the session is initialized.
    link.send({ method: 'chrome.tabs.onCreated', params: [{ id: 5 }] });
    link.send({ method: 'extension.initialized', params: [] });
    control.link.send({ id: request.id, result: { sessionId: 3 } });

    const session = await opening;
    const events: [string, unknown[]][] = [];

    assert.equal(session.id, 3);
    session.onEvent = (method, params) => events.push([method, params]);
    assert.deepEqual(events, [['chrome.tabs.onCreated', [{ id: 5 }]]]);

    const answer = session.send('chrome.debugger.attach', [{ tabId: 5 }, '1.3']);
    const command = await link.next();

    assert.deepEqual([command.method, command.params], ['chrome.debugger.attach', [{ tabId: 5 }, '1.3']]);
    link.send({ id: command.id, result: {} });
    assert.deepEqual(await answer, {});

    session.close();
    assert.equal((await link.closed).code, 1000);
    assert.equal((await session.ended).end, 'closed');
    await control.close();
  });

  test('is not opened when the extension refuses', async () => {
    const control = await connectTalking();
    const refused = hub.browser('b1')!.openSession({ clientName: 'test', label: '' });

    control.link.send({ id: (await control.link.next()).id, error: 'No window to open a tab in' });
    await assert.rejects(refused, /No window to open a tab in/);
    await control.close();
  });

  test('ends as the side that ended it says: the user stopped it, the link was lost, access was withdrawn', async () => {
    const control = await connectTalking();
    const browser = hub.browser('b1')!;

    let opening = browser.openSession({ clientName: 'test', label: '' });
    let link = await openSessionLink(port, HOST, control.link);
    let session = await opening;
    const waiting = session.send('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.enable']);

    waiting.catch(() => {});
    link.close(CLOSE_SESSION_STOPPED, 'The user stopped the session in the browser');
    assert.deepEqual(await session.ended, { end: 'stopped', detail: 'The user stopped the session in the browser' });
    await assert.rejects(waiting, /The user stopped the session/);

    opening = browser.openSession({ clientName: 'test', label: '' });
    link = await openSessionLink(port, HOST, control.link, 2);
    session = await opening;
    link.close(1000, 'Pairing');
    assert.equal((await session.ended).end, 'lost');

    opening = browser.openSession({ clientName: 'test', label: '' });
    link = await openSessionLink(port, HOST, control.link, 3);
    session = await opening;
    hub.revoke('b1');
    assert.equal((await link.closed).code, CLOSE_SESSION_REVOKED);
    assert.equal((await session.ended).end, 'revoked');
    assert.equal((await control.link.closed).code, CLOSE_UNAUTHORIZED);
    await control.close();
  });

  test('ends as lost when its browser leaves the control link', async () => {
    const control = await connectTalking();
    const opening = hub.browser('b1')!.openSession({ clientName: 'test', label: '' });
    const link = await openSessionLink(port, HOST, control.link);
    const session = await opening;

    await control.close();
    assert.equal((await session.ended).end, 'lost');
    await link.closed;
  });

  test('that says nothing is kept by the pings of the server', async () => {
    const control = await connectTalking();
    const opening = hub.browser('b1')!.openSession({ clientName: 'test', label: '' });
    const link = await openSessionLink(port, HOST, control.link);
    const session = await opening;
    let over = false;

    void session.ended.then(() => {
      over = true;
    });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(link.pings() >= 3, `pings on the session link: ${link.pings()}`);
    assert.ok(control.link.pings() >= 3, `pings on the control link: ${control.link.pings()}`);
    assert.equal(over, false, 'a silent session that answers the pings lives');

    session.close();
    await link.closed;
    await control.close();
  });
});
