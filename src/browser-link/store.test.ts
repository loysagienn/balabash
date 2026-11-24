// The store of linked browsers (store.ts) over the stand
// (src/test-support/stand.ts): a pairing makes a row enabled in its
// workspace and hands out the secret once; the secret finds the row and a
// deleted row's secret finds nothing; only the owner changes a browser;
// from a workspace a user sees their own browsers and those of others
// enabled there.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let store: typeof import('./store.ts');

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  store = await import('./store.ts');
});

after(() => stand.stop());

const newUser = async (displayName: string) => (await prisma.user.create({ data: { displayName } })).id;
const newWorkspace = async () => (await prisma.workspace.create({ data: {} })).id;

const refuses = (code: string) => (error: unknown) => error instanceof store.BrowserError && error.code === code;

describe('a pairing', () => {
  test('makes a browser of the user, enabled in the workspace it was started from, and its secret finds it', async () => {
    const userId = await newUser('Ada');
    const workspaceId = await newWorkspace();
    const { browser, secret, replacedId } = await store.pairBrowser({ userId, workspaceId, name: '  MacBook  ' });

    assert.equal(browser.name, 'MacBook');
    assert.equal(browser.userId, userId);
    assert.equal(replacedId, null);
    assert.deepEqual(await store.browserWorkspaces(browser.id), [workspaceId]);
    assert.equal((await store.findBrowserBySecret(secret))?.id, browser.id);
    assert.equal(await store.findBrowserBySecret('some-other-secret'), null);

    const row = await prisma.userBrowser.findUniqueOrThrow({ where: { id: browser.id } });

    assert.ok(!row.secretHash.includes(secret), 'the row keeps a hash, not the secret');
  });

  test('refuses a name the user already has, and an empty or a long one; another user may have the same name', async () => {
    const userId = await newUser('Ada');
    const workspaceId = await newWorkspace();

    await store.pairBrowser({ userId, workspaceId, name: 'Work' });

    await assert.rejects(store.pairBrowser({ userId, workspaceId, name: 'Work' }), refuses('name_taken'));
    await assert.rejects(store.assertBrowserNameFree(userId, 'Work'), refuses('name_taken'));
    await assert.rejects(store.pairBrowser({ userId, workspaceId, name: '   ' }), refuses('invalid_name'));
    await assert.rejects(store.pairBrowser({ userId, workspaceId, name: 'x'.repeat(61) }), refuses('invalid_name'));

    await store.assertBrowserNameFree(userId, 'Home');
    await store.pairBrowser({ userId: await newUser('Grace'), workspaceId, name: 'Work' });
  });

  test('with the secret the extension had before replaces that browser: its row and its secret are gone', async () => {
    const userId = await newUser('Ada');
    const workspaceId = await newWorkspace();
    const first = await store.pairBrowser({ userId, workspaceId, name: 'Laptop' });
    const second = await store.pairBrowser({ userId, workspaceId, name: 'Laptop', previousSecret: first.secret });

    assert.equal(second.replacedId, first.browser.id);
    assert.notEqual(second.browser.id, first.browser.id);
    assert.equal(await store.findBrowserBySecret(first.secret), null);
    assert.equal((await store.findBrowserBySecret(second.secret))?.id, second.browser.id);
    assert.deepEqual(await store.browserWorkspaces(first.browser.id), []);

    // A secret that stands for nothing replaces nothing.
    const third = await store.pairBrowser({ userId, workspaceId, name: 'Another', previousSecret: first.secret });

    assert.equal(third.replacedId, null);
  });
});

describe('a paired browser', () => {
  test('remembers when it dialed in and with which extension', async () => {
    const { browser } = await store.pairBrowser({ userId: await newUser('Ada'), workspaceId: await newWorkspace(), name: 'Seen' });

    assert.equal(browser.lastSeenAt, null);

    const seen = await store.recordBrowserSeen(browser.id, '0.2.0');

    assert.equal(seen?.extensionVersion, '0.2.0');
    assert.ok(seen?.lastSeenAt instanceof Date);
    assert.equal(await store.recordBrowserSeen('no-such-browser', '0.2.0'), null);
  });

  test('is renamed, enabled, disabled and disconnected by its owner only', async () => {
    const ownerId = await newUser('Ada');
    const strangerId = await newUser('Mallory');
    const workspaceId = await newWorkspace();
    const otherWorkspaceId = await newWorkspace();
    const { browser, secret } = await store.pairBrowser({ userId: ownerId, workspaceId, name: 'Mine' });

    await assert.rejects(store.renameBrowser(strangerId, browser.id, 'Theirs'), refuses('not_found'));
    await assert.rejects(store.enableBrowser(strangerId, browser.id, otherWorkspaceId), refuses('not_found'));
    await assert.rejects(store.disableBrowser(strangerId, browser.id, workspaceId), refuses('not_found'));
    await assert.rejects(store.deleteBrowser(strangerId, browser.id), refuses('not_found'));
    assert.deepEqual(await store.browserWorkspaces(browser.id), [workspaceId]);

    assert.equal((await store.renameBrowser(ownerId, browser.id, ' Renamed ')).name, 'Renamed');
    await store.pairBrowser({ userId: ownerId, workspaceId, name: 'Second' });
    await assert.rejects(store.renameBrowser(ownerId, browser.id, 'Second'), refuses('name_taken'));

    await store.enableBrowser(ownerId, browser.id, otherWorkspaceId);
    await store.enableBrowser(ownerId, browser.id, otherWorkspaceId);
    assert.deepEqual((await store.browserWorkspaces(browser.id)).sort(), [workspaceId, otherWorkspaceId].sort());

    await store.disableBrowser(ownerId, browser.id, workspaceId);
    assert.deepEqual(await store.browserWorkspaces(browser.id), [otherWorkspaceId]);

    const deleted = await store.deleteBrowser(ownerId, browser.id);

    assert.deepEqual(deleted.workspaceIds, [otherWorkspaceId]);
    assert.equal(await store.findBrowserBySecret(secret), null, 'a disconnected browser is nobody');
    assert.deepEqual(await store.browserWorkspaces(browser.id), []);
  });
});

describe('the browsers seen from a workspace', () => {
  test('are all of the user’s own — enabled here or not — and those of others enabled here, with the owner’s name', async () => {
    const adaId = await newUser('Ada');
    const graceId = await newUser('Grace');
    const here = await newWorkspace();
    const elsewhere = await newWorkspace();
    const adaHere = await store.pairBrowser({ userId: adaId, workspaceId: here, name: 'Ada here' });
    const adaElsewhere = await store.pairBrowser({ userId: adaId, workspaceId: elsewhere, name: 'Ada elsewhere' });
    const graceHere = await store.pairBrowser({ userId: graceId, workspaceId: here, name: 'Grace here' });

    await store.pairBrowser({ userId: graceId, workspaceId: elsewhere, name: 'Grace elsewhere' });

    const listing = await store.listBrowsers(adaId, here);

    assert.deepEqual(
      listing.own.map(browser => [browser.id, browser.enabledHere]),
      [
        [adaHere.browser.id, true],
        [adaElsewhere.browser.id, false],
      ],
    );
    assert.deepEqual(
      listing.others.map(browser => [browser.id, browser.ownerName]),
      [[graceHere.browser.id, 'Grace']],
    );
  });
});
