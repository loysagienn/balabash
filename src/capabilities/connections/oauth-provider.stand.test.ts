// The interactive OAuth provider over the stand: a changed redirect URI or
// authorization server requires a fresh dynamic client registration.
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from '../../test-support/stand.ts';
import type { Stand } from '../../test-support/stand.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';
import type { Prisma } from '../../../prisma-generated/client.ts';

const DOMAIN = 'console.test';
const REDIRECT = `https://${DOMAIN}/oauth/callback`;
const SERVER = 'notion';

let stand: Stand;
let prisma: typeof import('../../db/client.ts')['prisma'];
let provider: typeof import('./oauth-provider.ts');
let connection: ConnectionModel;

before(async () => {
  stand = await startStand();
  // The redirect URI of this process is built from CONSOLE_DOMAIN
  // (src/config/index.ts); the stand sets its own, named here explicitly.
  process.env.CONSOLE_DOMAIN = DOMAIN;
  ({ prisma } = await import('../../db/client.ts'));
  provider = await import('./oauth-provider.ts');
  connection = await prisma.connection.create({
    data: {
      workspaceId: stand.workspaceId,
      threadId: stand.mainThreadId,
      server: SERVER,
      accountKey: 'main',
      displayName: 'Main',
      status: 'pending',
      pendingState: 'state-1',
    },
  });
});

after(() => stand.stop());

beforeEach(() => prisma.oauthClient.deleteMany({ where: { server: SERVER } }));

function store(clientInformation: Prisma.InputJsonObject) {
  return prisma.oauthClient.create({ data: { server: SERVER, clientInformation } });
}

function interactive(authorizationServer?: string) {
  return provider.createInteractiveAuthProvider(connection, { url: null }, authorizationServer);
}

async function storedRow() {
  return (await prisma.oauthClient.findUnique({ where: { server: SERVER } }))?.clientInformation;
}

describe('the client registration and the current redirect URI', () => {
  test('a DCR registration that names the current redirect URI is served by the flow', async () => {
    const info = { client_id: 'dcr-current', redirect_uris: [REDIRECT] };

    await store(info);

    assert.deepEqual(await interactive().clientInformation(), info);
  });

  test('a DCR registration bound to another redirect URI: the interactive flow sees no client; the SDK’s save replaces the row', async () => {
    const stale = { client_id: 'dcr-old', redirect_uris: ['https://old.test/oauth/callback'] };

    await store(stale);

    assert.equal(await interactive().clientInformation(), undefined);
    assert.deepEqual(await storedRow(), stale, 'the judgement itself changes nothing');

    const fresh = { client_id: 'dcr-new', redirect_uris: [REDIRECT] };

    await interactive().saveClientInformation!(fresh);

    assert.deepEqual(await storedRow(), fresh);
    assert.deepEqual(await interactive().clientInformation(), fresh);
  });

  test('a registration that differs from the sent string only as a URL (:443, host case) is stale too', async () => {
    for (const uri of [`https://${DOMAIN}:443/oauth/callback`, `https://${DOMAIN.toUpperCase()}/oauth/callback`]) {
      await prisma.oauthClient.deleteMany({ where: { server: SERVER } });
      await store({ client_id: 'dcr-variant', redirect_uris: [uri] });

      assert.equal(await interactive().clientInformation(), undefined, uri);
    }
  });

  test('a client provisioned by hand (no redirect_uris) is served by the flow whatever the domain', async () => {
    const manual = { client_id: 'google-client', client_secret: 'google-secret' };

    await store(manual);

    assert.deepEqual(await interactive().clientInformation(), manual);
    assert.deepEqual(await storedRow(), manual);
  });

  test('no row at all: the flow reports no client', async () => {
    assert.equal(await interactive().clientInformation(), undefined);
  });
});

describe('the client registration and the authorization server of the flow', () => {
  const ID = 'https://id.test';
  const FORMER = 'https://mcp.notion.test/mcp';

  test('a registration stamped with the server of the flow is served; one stamped with another server: the interactive flow sees no client', async () => {
    const current = { client_id: 'dcr-id', redirect_uris: [REDIRECT], authorization_server: ID };

    await store(current);
    assert.deepEqual(await interactive(ID).clientInformation(), current);
    assert.deepEqual(await interactive(`${ID}/`).clientInformation(), current, 'a trailing slash is the same server');

    await prisma.oauthClient.deleteMany({ where: { server: SERVER } });

    const moved = { client_id: 'dcr-former', redirect_uris: [REDIRECT], authorization_server: FORMER };

    await store(moved);
    assert.equal(await interactive(ID).clientInformation(), undefined);
    assert.deepEqual(await storedRow(), moved, 'the judgement itself changes nothing');
  });

  test('a registration without a stamp, or a flow without a known server, is not judged', async () => {
    const unstamped = { client_id: 'dcr-old', redirect_uris: [REDIRECT] };

    await store(unstamped);
    assert.deepEqual(await interactive(ID).clientInformation(), unstamped);

    await prisma.oauthClient.deleteMany({ where: { server: SERVER } });
    await store({ client_id: 'dcr-former', redirect_uris: [REDIRECT], authorization_server: FORMER });
    assert.deepEqual(await interactive().clientInformation(), {
      client_id: 'dcr-former',
      redirect_uris: [REDIRECT],
      authorization_server: FORMER,
    });
  });

  test('the SDK’s save through a flow with a known server stamps the row with it; without one it saves the answer as is', async () => {
    const answer = { client_id: 'dcr-new', redirect_uris: [REDIRECT] };

    await interactive(ID).saveClientInformation!(answer);
    assert.deepEqual(await storedRow(), { ...answer, authorization_server: ID });
    assert.deepEqual(await interactive(ID).clientInformation(), { ...answer, authorization_server: ID });

    await interactive().saveClientInformation!(answer);
    assert.deepEqual(await storedRow(), answer);
  });
});
