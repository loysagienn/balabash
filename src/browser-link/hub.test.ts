// The hub of the browser links (hub.ts) with a client that plays the
// extension (test-client.ts): which upgrade requests become links, who a
// `hello` makes a connected browser, and how a link ends.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBrowserLinkHub } from './hub.ts';
import type { Admission, BrowserLinkHub } from './hub.ts';
import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_PROTOCOL } from './protocol.ts';
import type { HelloParams, WelcomeParams } from './protocol.ts';
import { EXTENSION_ORIGIN, dial, hello } from './test-client.ts';

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
  hub = createBrowserLinkHub({ admit, extensionVersion: async () => '0.9.0', host: HOST, origin: EXTENSION_ORIGIN, idleTimeoutMs: 300 });
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
