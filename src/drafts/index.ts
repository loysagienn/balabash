// Message drafts: a user's unsent message of a thread, saved from the
// console's composer and read back on any of their devices (the
// message_drafts table — one row per user and thread, never an event of
// the log). The row is the truth; a client names the revision it last
// saw with every write (optimistic lock): a write over a stale revision is
// refused with the server's version, so a device that slept with an old
// text can never overwrite what was typed since on another. The revision
// only grows — a cleared draft (an emptied composer, a sent message) is
// the row with empty content, never a deleted one.
//
// The change itself travels to the user's other open consoles as an
// ephemeral signal (draftSignals → the `draft` frame of the event stream,
// src/api/event-stream.ts): the thread and the new revision only — the
// receiver reads the row itself. A lost signal costs nothing: a console
// reads the draft on opening the thread, on its tab coming back and after
// a reconnect anyway.

import { Prisma } from '../../prisma-generated/client.ts';
import type { MessageDraftModel } from '../../prisma-generated/models.ts';
import { prisma } from '../db/client.ts';
import type { Tx } from '../core/append.ts';
import type { FileRef } from '../core/contract.ts';
import { FileNotFoundError, getWorkspaceFile } from '../files/index.ts';

// A draft as the API answers it: the text, the stored files (their facts
// resolved — a file gone from storage is left out), the revision a later
// write names.
export type DraftRecord = {
  threadId: string;
  text: string;
  files: FileRef[];
  revision: number;
  updatedAt: Date;
};

export type DraftContent = { text: string; fileIds: string[] };

export type WriteDraftInput = DraftContent & {
  userId: string;
  threadId: string;
  // The revision the writer's content is based on; 0 — no draft seen.
  baseRevision: number;
  sessionId: string | null;
};

// The outcome of a write: saved — the row as it is now; conflict — the
// base named is not the current revision, with the current row (null —
// there is none, the base was stale in a world where nothing was saved).
export type WriteDraftResult = { ok: true; draft: DraftRecord } | { ok: false; current: DraftRecord | null };

export function isEmptyDraft(content: DraftContent): boolean {
  return content.text === '' && content.fileIds.length === 0;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// The files of the row as they are now: the stored files of the thread's
// workspace by the one lookup rule (getWorkspaceFile), the gone ones
// dropped silently — a draft is not refused for a file it once had.
async function recordOf(row: MessageDraftModel, workspaceId: string): Promise<DraftRecord> {
  const files: FileRef[] = [];

  for (const fileId of row.fileIds) {
    try {
      files.push(await getWorkspaceFile(workspaceId, fileId));
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) {
        throw error;
      }
    }
  }

  return { threadId: row.threadId, text: row.text, files, revision: row.revision, updatedAt: row.updatedAt };
}

export async function readDraft(userId: string, threadId: string, workspaceId: string): Promise<DraftRecord | null> {
  const row = await prisma.messageDraft.findUnique({ where: { userId_threadId: { userId, threadId } } });

  return row ? recordOf(row, workspaceId) : null;
}

// Writes the content over the base revision named. An empty content over
// no row at all writes nothing (there is nothing to clear) and answers
// the absence; otherwise the row is created (base 0) or updated where its
// revision is the base, and any other state of the row is a conflict with
// the row as it is.
export async function writeDraft(input: WriteDraftInput, workspaceId: string): Promise<WriteDraftResult> {
  const { userId, threadId, text, fileIds, baseRevision, sessionId } = input;

  if (baseRevision === 0) {
    if (isEmptyDraft(input)) {
      const current = await prisma.messageDraft.findUnique({ where: { userId_threadId: { userId, threadId } } });

      return current ? { ok: false, current: await recordOf(current, workspaceId) } : { ok: true, draft: { threadId, text: '', files: [], revision: 0, updatedAt: new Date() } };
    }

    try {
      const row = await prisma.messageDraft.create({ data: { userId, threadId, text, fileIds, revision: 1, updatedBySession: sessionId } });

      signalDraft({ userId, workspaceId, threadId, revision: row.revision });

      return { ok: true, draft: await recordOf(row, workspaceId) };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const current = await prisma.messageDraft.findUnique({ where: { userId_threadId: { userId, threadId } } });

      return { ok: false, current: current ? await recordOf(current, workspaceId) : null };
    }
  }

  const updated = await prisma.messageDraft.updateMany({
    where: { userId, threadId, revision: baseRevision },
    data: { text, fileIds, revision: baseRevision + 1, updatedBySession: sessionId },
  });

  if (updated.count === 0) {
    const current = await prisma.messageDraft.findUnique({ where: { userId_threadId: { userId, threadId } } });

    return { ok: false, current: current ? await recordOf(current, workspaceId) : null };
  }

  const row = await prisma.messageDraft.findUniqueOrThrow({ where: { userId_threadId: { userId, threadId } } });

  signalDraft({ userId, workspaceId, threadId, revision: row.revision });

  return { ok: true, draft: await recordOf(row, workspaceId) };
}

// The clear of a sent message, inside the sender's transaction (the
// message and the clear commit together): the row, if any, empties and
// moves on a revision — a save of the sent text still in flight from
// another device lands on a stale base and is refused. Answers the new
// revision for the signal the caller sends after the commit, null without
// a row.
export async function clearDraftIn(tx: Tx, userId: string, threadId: string): Promise<number | null> {
  const rows = await tx.$queryRaw<{ revision: number }[]>`
    UPDATE "message_drafts"
    SET "text" = '', "file_ids" = '{}', "revision" = "revision" + 1, "updated_by_session" = NULL, "updated_at" = NOW()
    WHERE "user_id" = ${userId} AND "thread_id" = ${threadId}
    RETURNING "revision"
  `;

  return rows[0]?.revision ?? null;
}

// --------------------------------------------------------------------------
// The signals: in-process, ephemeral, one listener per open event stream.
// Delivered to the streams of the same user in the same workspace — the
// writer's own included (it recognises its own revision and stays quiet).

export type DraftSignal = { userId: string; workspaceId: string; threadId: string; revision: number };

export type DraftSignalListener = (signal: DraftSignal) => void;

export type DraftSignals = {
  notify(signal: DraftSignal): void;
  // Every signal of the user in the workspace, until unsubscribed.
  subscribe(userId: string, workspaceId: string, listener: DraftSignalListener): () => void;
};

export function createDraftSignals(): DraftSignals {
  const listeners = new Set<{ userId: string; workspaceId: string; listener: DraftSignalListener }>();

  return {
    notify(signal) {
      for (const entry of listeners) {
        if (entry.userId === signal.userId && entry.workspaceId === signal.workspaceId) {
          try {
            entry.listener(signal);
          } catch (error) {
            console.error('[drafts] signal listener failed:', error);
          }
        }
      }
    },
    subscribe(userId, workspaceId, listener) {
      const entry = { userId, workspaceId, listener };

      listeners.add(entry);

      return () => {
        listeners.delete(entry);
      };
    },
  };
}

export const draftSignals: DraftSignals = createDraftSignals();

// Fire-and-forget from the write paths: never throws.
export function signalDraft(signal: DraftSignal): void {
  try {
    draftSignals.notify(signal);
  } catch (error) {
    console.error('[drafts] signal failed:', error);
  }
}
