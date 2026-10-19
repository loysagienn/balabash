// Users: the people behind sessions and messages. A user is a row of
// `users`; the ways they prove to be themselves are `user_identities`
// (provider + id → user), the workspaces they are in `workspace_members`.
// Nothing here is registered by hand — a user is born of the first fact
// the system already trusts: a message or /auth_code of a Telegram account
// in a bound group (membership of the group is the workspace's trust
// boundary), the console code of the installation's operator (whoever reads
// the server log). One rule for the owner of a workspace: the first user
// allowed to activate workspaces (TELEGRAM_ALLOWED_LOGINS) seen in its
// group — for a new workspace the one whose /start created it; for a
// workspace without a group, the operator.
//
// The identity a channel writes into the log (user.message.identity and
// the thread commands) names the user (userId) and their name as of that
// moment — the log stays readable without this table (and keeps the name
// the person went by then), the table says who is who.

import { Prisma } from '../../prisma-generated/client.ts';
import type { UserModel } from '../../prisma-generated/models.ts';
import { prisma } from '../db/client.ts';
import type { Tx } from '../core/append.ts';
import type { UserIdentity } from '../core/event-types.ts';

export type UserRole = 'owner' | 'member';

// A user as the rest of the app refers to them.
export type UserRef = { userId: string; displayName: string | null };

export const TELEGRAM_PROVIDER = 'telegram';
export const CONSOLE_PROVIDER = 'console';
// The one console identity of an installation.
export const CONSOLE_PROVIDER_ID = 'host';
// The operator's name until they set one in Settings.
export const CONSOLE_DEFAULT_NAME = 'Operator';

// What Telegram tells about the account behind a message (grammY's
// `from`): the id is the account, the rest is profile.
export type TelegramProfile = { id: number; username?: string; first_name: string; last_name?: string };

function userRef(user: Pick<UserModel, 'id' | 'displayName'>): UserRef {
  return { userId: user.id, displayName: user.displayName };
}

// The name Telegram shows for the account: first and last name; the
// username when the profile has no name at all.
export function telegramDisplayName(profile: TelegramProfile): string | null {
  const name = [profile.first_name, profile.last_name].filter(part => typeof part === 'string' && part.trim()).join(' ').trim();

  return name || (profile.username ? `@${profile.username}` : null);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// Puts the user into the workspace; answers their role. claimOwner — the
// user may own the workspace: they become its owner when it has none (a
// member already there is promoted). Serialized on the workspace row, so
// two claimants at once cannot both become the owner.
export async function ensureMembership(tx: Tx, workspaceId: string, userId: string, claimOwner: boolean): Promise<UserRole> {
  await tx.$executeRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;

  const existing = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });

  if (existing?.role === 'owner' || (existing && !claimOwner)) {
    return existing.role as UserRole;
  }

  const owner = claimOwner ? await tx.workspaceMember.findFirst({ where: { workspaceId, role: 'owner' } }) : null;
  const role: UserRole = claimOwner && !owner ? 'owner' : 'member';

  if (existing) {
    if (role !== existing.role) {
      await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } });
    }
  } else {
    await tx.workspaceMember.create({ data: { workspaceId, userId, role } });
  }

  return role;
}

// The user behind a Telegram account, created on first sight. The profile
// (username, name) is refreshed every time; the user's name follows it
// until they set a name of their own in Settings.
async function upsertTelegramUser(tx: Tx, profile: TelegramProfile): Promise<UserRef> {
  const providerId = String(profile.id);
  const profileJson = { username: profile.username ?? null, firstName: profile.first_name, lastName: profile.last_name ?? null };
  const identity = await tx.userIdentity.findUnique({ where: { provider_providerId: { provider: TELEGRAM_PROVIDER, providerId } } });

  if (!identity) {
    const user = await tx.user.create({ data: { displayName: telegramDisplayName(profile) } });

    await tx.userIdentity.create({ data: { provider: TELEGRAM_PROVIDER, providerId, userId: user.id, profile: profileJson } });

    return userRef(user);
  }

  await tx.userIdentity.update({ where: { provider_providerId: { provider: TELEGRAM_PROVIDER, providerId } }, data: { profile: profileJson, lastSeenAt: new Date() } });

  const user = await tx.user.findUniqueOrThrow({ where: { id: identity.userId } });
  const fromProfile = telegramDisplayName(profile);

  if (!user.nameSetByUser && user.displayName !== fromProfile) {
    return userRef(await tx.user.update({ where: { id: user.id }, data: { displayName: fromProfile } }));
  }

  return userRef(user);
}

// A Telegram account acting in a bound group: the user (created on first
// sight, profile refreshed) and their membership in the group's workspace.
// claimOwner — the account is allowed to activate workspaces
// (TELEGRAM_ALLOWED_LOGINS): the first such account seen owns a workspace
// that has no owner yet.
export async function resolveTelegramUser(profile: TelegramProfile, workspaceId: string, options: { claimOwner: boolean }): Promise<UserRef> {
  const resolve = () =>
    prisma.$transaction(async tx => {
      const user = await upsertTelegramUser(tx, profile);

      await ensureMembership(tx, workspaceId, user.userId, options.claimOwner);

      return user;
    });

  try {
    return await resolve();
  } catch (error) {
    // Two first sightings of one account at once (two groups): the second
    // transaction lost the identity's primary key — it finds the row now.
    if (!isUniqueViolation(error)) {
      throw error;
    }

    return resolve();
  }
}

// The installation's operator: the one console identity, created on the
// first console code.
export async function resolveConsoleUser(): Promise<UserRef> {
  const resolve = () =>
    prisma.$transaction(async tx => {
      const identity = await tx.userIdentity.findUnique({ where: { provider_providerId: { provider: CONSOLE_PROVIDER, providerId: CONSOLE_PROVIDER_ID } } });

      if (identity) {
        return userRef(await tx.user.findUniqueOrThrow({ where: { id: identity.userId } }));
      }

      const user = await tx.user.create({ data: { displayName: CONSOLE_DEFAULT_NAME } });

      await tx.userIdentity.create({ data: { provider: CONSOLE_PROVIDER, providerId: CONSOLE_PROVIDER_ID, userId: user.id } });

      return userRef(user);
    });

  try {
    return await resolve();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    return resolve();
  }
}

// The operator signing in to a workspace with the console code: a member
// of it; its owner when the workspace has no Telegram group (nobody else
// could have created it) and no owner yet.
export async function joinConsoleUser(workspaceId: string): Promise<UserRef> {
  const user = await resolveConsoleUser();

  await prisma.$transaction(async tx => {
    const group = await tx.telegramGroup.findUnique({ where: { workspaceId }, select: { chatId: true } });

    await ensureMembership(tx, workspaceId, user.userId, group === null);
  });

  return user;
}

export async function readUser(userId: string): Promise<UserRef | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } });

  return user ? userRef(user) : null;
}

// The name set in Settings: a string is the user's own from now on (the
// channel's profile stops refreshing it); null hands the name back to the
// profile — the next sighting fills it in, and until then the user has
// none.
export async function setUserName(userId: string, displayName: string | null): Promise<UserRef> {
  return userRef(await prisma.user.update({ where: { id: userId }, data: { displayName, nameSetByUser: displayName !== null } }));
}

// The identity payload of a web-authored event: the user of the session.
export function webIdentity(user: UserRef): UserIdentity {
  return { userId: user.userId, displayName: user.displayName };
}

// The identity payload of a Telegram-authored event: the user, and the
// account's username when it has one (the handle people know each other
// by; the prompts show it beside the name). The rest of the profile and
// the account's id live in user_identities, not in every event.
export function telegramIdentity(user: UserRef, profile: TelegramProfile): UserIdentity {
  return { ...webIdentity(user), ...(profile.username ? { username: profile.username } : {}) };
}
