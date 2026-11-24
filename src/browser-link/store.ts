// The browsers users linked to the installation: the rows of `user_browsers`
// and of `user_browser_workspaces` (prisma/schema.prisma) and every change
// of them. A browser belongs to the user who paired it; only the owner
// renames it, enables or disables it in a workspace and disconnects it —
// to anyone else the browser does not exist (`not_found`). What a workspace
// sees of the browsers of others is the ones enabled in it.
//
// The secret of a pairing is made here and leaves once, to the extension;
// the row keeps its hash. It is never logged.

import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '../../prisma-generated/client.ts';
import type { UserBrowserModel } from '../../prisma-generated/models.ts';
import { config } from '../config/index.ts';
import { prisma } from '../db/client.ts';

const NAME_MAX_LENGTH = 60;

export type BrowserRecord = {
  id: string;
  userId: string;
  name: string;
  // What the extension said at its last `hello`; null before the first one.
  extensionVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

// The browsers a user sees from a workspace: all of their own, and the ones
// of others enabled there.
export type BrowserListing = {
  own: (BrowserRecord & { enabledHere: boolean })[];
  others: (BrowserRecord & { ownerName: string | null })[];
};

export type BrowserErrorCode = 'not_found' | 'name_taken' | 'invalid_name';

export class BrowserError extends Error {
  code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function record(row: UserBrowserModel): BrowserRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    extensionVersion: row.extensionVersion,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

// IMPORTANT: never log or expose the secret.
function hashSecret(secret: string): string {
  return createHash('sha256')
    .update(secret + config.sessionPepper)
    .digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const nameTaken = (name: string) => new BrowserError('name_taken', `You already have a browser named "${name}"`);

// The name as it is stored: trimmed, not empty, not long.
export function browserName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';

  if (!name || name.length > NAME_MAX_LENGTH) {
    throw new BrowserError('invalid_name', `A browser needs a name of 1 to ${NAME_MAX_LENGTH} characters`);
  }

  return name;
}

// Throws `name_taken` when the user already has a browser of this name.
export async function assertBrowserNameFree(userId: string, name: string): Promise<void> {
  if (await prisma.userBrowser.findUnique({ where: { userId_name: { userId, name } }, select: { id: true } })) {
    throw nameTaken(name);
  }
}

// A pairing: the new row, enabled in the workspace the pairing was started
// from, and its secret. `previousSecret` is the secret the extension had
// before: the row it stood for is the same browser's and is replaced.
export async function pairBrowser(input: {
  userId: string;
  workspaceId: string;
  name: string;
  previousSecret?: string;
}): Promise<{ browser: BrowserRecord; secret: string; replacedId: string | null }> {
  const name = browserName(input.name);
  const secret = randomBytes(32).toString('base64url');

  try {
    return await prisma.$transaction(async tx => {
      const previous = input.previousSecret
        ? await tx.userBrowser.findUnique({ where: { secretHash: hashSecret(input.previousSecret) }, select: { id: true } })
        : null;

      if (previous) {
        await tx.userBrowserWorkspace.deleteMany({ where: { browserId: previous.id } });
        await tx.userBrowser.delete({ where: { id: previous.id } });
      }

      const row = await tx.userBrowser.create({ data: { userId: input.userId, name, secretHash: hashSecret(secret) } });

      await tx.userBrowserWorkspace.create({ data: { browserId: row.id, workspaceId: input.workspaceId } });

      return { browser: record(row), secret, replacedId: previous?.id ?? null };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw nameTaken(name);
    }

    throw error;
  }
}

export async function findBrowserBySecret(secret: string): Promise<BrowserRecord | null> {
  const row = await prisma.userBrowser.findUnique({ where: { secretHash: hashSecret(secret) } });

  return row ? record(row) : null;
}

// The browser dialed in: when, and with which extension. Null when the row
// is gone meanwhile.
export async function recordBrowserSeen(id: string, extensionVersion: string): Promise<BrowserRecord | null> {
  const { count } = await prisma.userBrowser.updateMany({ where: { id }, data: { extensionVersion, lastSeenAt: new Date() } });
  const row = count ? await prisma.userBrowser.findUnique({ where: { id } }) : null;

  return row ? record(row) : null;
}

export async function listBrowsers(userId: string, workspaceId: string): Promise<BrowserListing> {
  const enabledHere = new Set(
    (await prisma.userBrowserWorkspace.findMany({ where: { workspaceId }, select: { browserId: true } })).map(row => row.browserId),
  );
  const rows = await prisma.userBrowser.findMany({
    where: { OR: [{ userId }, { id: { in: [...enabledHere] } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const others = rows.filter(row => row.userId !== userId);
  const owners = await prisma.user.findMany({
    where: { id: { in: [...new Set(others.map(row => row.userId))] } },
    select: { id: true, displayName: true },
  });
  const ownerNames = new Map(owners.map(owner => [owner.id, owner.displayName]));

  return {
    own: rows.filter(row => row.userId === userId).map(row => ({ ...record(row), enabledHere: enabledHere.has(row.id) })),
    others: others.map(row => ({ ...record(row), ownerName: ownerNames.get(row.userId) ?? null })),
  };
}

// The workspaces a browser is enabled in.
export async function browserWorkspaces(browserId: string): Promise<string[]> {
  return (await prisma.userBrowserWorkspace.findMany({ where: { browserId }, select: { workspaceId: true } })).map(row => row.workspaceId);
}

async function ownBrowser(userId: string, id: string): Promise<UserBrowserModel> {
  const row = await prisma.userBrowser.findUnique({ where: { id } });

  if (!row || row.userId !== userId) {
    throw new BrowserError('not_found', 'No such browser');
  }

  return row;
}

export async function renameBrowser(userId: string, id: string, value: unknown): Promise<BrowserRecord> {
  const name = browserName(value);

  await ownBrowser(userId, id);

  try {
    return record(await prisma.userBrowser.update({ where: { id }, data: { name } }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw nameTaken(name);
    }

    throw error;
  }
}

// Enabled already — stays so.
export async function enableBrowser(userId: string, id: string, workspaceId: string): Promise<BrowserRecord> {
  const row = await ownBrowser(userId, id);

  await prisma.userBrowserWorkspace.upsert({
    where: { browserId_workspaceId: { browserId: id, workspaceId } },
    create: { browserId: id, workspaceId },
    update: {},
  });

  return record(row);
}

export async function disableBrowser(userId: string, id: string, workspaceId: string): Promise<BrowserRecord> {
  const row = await ownBrowser(userId, id);

  await prisma.userBrowserWorkspace.deleteMany({ where: { browserId: id, workspaceId } });

  return record(row);
}

// Disconnects the browser for good: the row and its secret are gone.
// Answers the workspaces it was enabled in.
export async function deleteBrowser(userId: string, id: string): Promise<{ browser: BrowserRecord; workspaceIds: string[] }> {
  const row = await ownBrowser(userId, id);

  return await prisma.$transaction(async tx => {
    const enabled = await tx.userBrowserWorkspace.findMany({ where: { browserId: id }, select: { workspaceId: true } });

    await tx.userBrowserWorkspace.deleteMany({ where: { browserId: id } });
    await tx.userBrowser.deleteMany({ where: { id } });

    return { browser: record(row), workspaceIds: enabled.map(entry => entry.workspaceId) };
  });
}
