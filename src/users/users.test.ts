// Users over the stand (src/test-support/stand.ts): a Telegram account
// seen in a bound group becomes a user of the group's workspace, an
// allowlisted one its owner when it has none; the name follows the
// Telegram profile until set in Settings; the installation's operator is
// one user, the owner of a workspace without a group.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let users: typeof import('./index.ts');

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  users = await import('./index.ts');
});

after(() => stand.stop());

async function newWorkspace(): Promise<string> {
  return (await prisma.workspace.create({ data: {} })).id;
}

async function membersOf(workspaceId: string): Promise<[string, string][]> {
  const rows = await prisma.workspaceMember.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });

  return rows.map(row => [row.userId, row.role]);
}

const ksenia = { id: 1001, username: 'KseniaNikolaev', first_name: 'Ксения', last_name: 'Николаева' };
const vladimir = { id: 1002, username: 'loysagienn', first_name: 'Vladimir' };
const kate = { id: 1003, first_name: 'Екатерина' };

describe('a Telegram account in a bound group', () => {
  test('becomes a user on first sight — named by the profile, identified by the id — and a member of the workspace; an allowlisted one owns a workspace without an owner', async () => {
    const workspaceId = await newWorkspace();

    const first = await users.resolveTelegramUser(ksenia, workspaceId, { claimOwner: false });

    assert.equal(first.displayName, 'Ксения Николаева');
    assert.deepEqual(await membersOf(workspaceId), [[first.userId, 'member']]);

    const identity = await prisma.userIdentity.findUniqueOrThrow({ where: { provider_providerId: { provider: 'telegram', providerId: '1001' } } });

    assert.equal(identity.userId, first.userId);
    assert.deepEqual(identity.profile, { username: 'KseniaNikolaev', firstName: 'Ксения', lastName: 'Николаева' });

    // Seen again: the same user, nothing new.
    const again = await users.resolveTelegramUser(ksenia, workspaceId, { claimOwner: false });

    assert.equal(again.userId, first.userId);
    assert.equal(await prisma.user.count(), 2, 'the operator and Ksenia');

    // The allowlisted account owns the workspace; the next allowlisted one
    // is a member — one owner.
    const owner = await users.resolveTelegramUser(vladimir, workspaceId, { claimOwner: true });
    const late = await users.resolveTelegramUser({ ...kate, username: 'katririum' }, workspaceId, { claimOwner: true });

    assert.deepEqual(await membersOf(workspaceId), [
      [first.userId, 'member'],
      [owner.userId, 'owner'],
      [late.userId, 'member'],
    ]);

    // A member promoted: allowlisted now, the workspace without an owner.
    const other = await newWorkspace();

    await users.resolveTelegramUser(ksenia, other, { claimOwner: false });
    await users.resolveTelegramUser(ksenia, other, { claimOwner: true });
    assert.deepEqual(await membersOf(other), [[first.userId, 'owner']]);

    // The same account in two workspaces is one user with two memberships.
    assert.equal((await prisma.workspaceMember.findMany({ where: { userId: first.userId } })).length, 2);
  });

  test('the name follows the Telegram profile until set in Settings; cleared, it is the profile’s again on the next sighting', async () => {
    const workspaceId = await newWorkspace();
    const seen = await users.resolveTelegramUser(kate, workspaceId, { claimOwner: false });

    assert.equal(seen.displayName, 'Екатерина');

    const renamed = await users.resolveTelegramUser({ ...kate, first_name: 'Катя', last_name: 'К.' }, workspaceId, { claimOwner: false });

    assert.equal(renamed.userId, seen.userId);
    assert.equal(renamed.displayName, 'Катя К.');

    await users.setUserName(seen.userId, 'Kate');
    assert.equal((await users.resolveTelegramUser({ ...kate, first_name: 'Someone' }, workspaceId, { claimOwner: false })).displayName, 'Kate');
    assert.deepEqual(await users.readUser(seen.userId), { userId: seen.userId, displayName: 'Kate' });

    await users.setUserName(seen.userId, null);
    assert.deepEqual(await users.readUser(seen.userId), { userId: seen.userId, displayName: null });
    assert.equal((await users.resolveTelegramUser({ ...kate, first_name: 'Someone' }, workspaceId, { claimOwner: false })).displayName, 'Someone');

    // A profile without a name goes by the username.
    assert.equal(users.telegramDisplayName({ id: 1, first_name: ' ', username: 'nobody' }), '@nobody');
    assert.equal(users.telegramDisplayName({ id: 1, first_name: ' ' }), null);
  });

  test('the identity an event carries: the user, and the channel’s username when there is one', () => {
    const user = { userId: 'u1', displayName: 'Kate' };

    assert.deepEqual(users.telegramIdentity(user, kate), { userId: 'u1', displayName: 'Kate' });
    assert.deepEqual(users.telegramIdentity(user, ksenia), { userId: 'u1', displayName: 'Kate', username: 'KseniaNikolaev' });
    assert.deepEqual(users.webIdentity(user), { userId: 'u1', displayName: 'Kate' });
  });
});

describe('the installation’s operator', () => {
  test('is one user: the owner of the stand’s workspace (no Telegram group), a member of a workspace with one', async () => {
    const operator = await users.resolveConsoleUser();

    assert.equal(operator.userId, stand.userId);
    assert.equal(operator.displayName, 'Operator');
    assert.deepEqual(await membersOf(stand.workspaceId), [[stand.userId, 'owner']]);
    assert.equal(await prisma.userIdentity.count({ where: { provider: 'console' } }), 1);

    const bound = await newWorkspace();

    await prisma.telegramGroup.create({ data: { chatId: -1009876543210n, workspaceId: bound, status: 'active' } });

    try {
      assert.equal((await users.joinConsoleUser(bound)).userId, stand.userId);
      assert.deepEqual(await membersOf(bound), [[stand.userId, 'member']]);
    } finally {
      await prisma.telegramGroup.deleteMany({ where: { workspaceId: bound } });
    }

    const unbound = await newWorkspace();

    await users.joinConsoleUser(unbound);
    assert.deepEqual(await membersOf(unbound), [[stand.userId, 'owner']]);
  });
});
