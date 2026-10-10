// The WHERE of a threads listing — the filters of GET /threads and of the
// snapshot window as composable SQL fragments (Prisma.sql), so the page
// query and the per-status count share one condition. Raw SQL because the
// search looks into the summary's text (summary->>'text') case-insensitively,
// which the query builder cannot express. The columns are qualified with
// the table: the reads join each row's thread.started in (threads.ts), and
// events shares column names with threads. Pure: no client, testable.

import { Prisma } from '../../prisma-generated/client.ts';
import type { ThreadStatus } from './contract.ts';

export type ThreadFilters = {
  status?: ThreadStatus;
  // null — root threads only (no parent).
  parentId?: string | null;
  projectId?: string;
  agent?: string;
  // A case-insensitive substring of the title, the description or the
  // summary text.
  q?: string;
  createdAtGte?: Date;
  createdAtLte?: Date;
  // Cursor for newest-first pagination: only threads with
  // createdSeq < beforeCreatedSeq. createdSeq is unique (the global seq of
  // thread.started), so equal createdAt timestamps page deterministically.
  beforeCreatedSeq?: bigint;
};

// The user's text as a LIKE pattern body: its wildcards and the escape
// character are literal (the default ESCAPE of Postgres is the backslash).
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

export function threadsWhere(userId: string, { status, parentId, projectId, agent, q, createdAtGte, createdAtLte, beforeCreatedSeq }: ThreadFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`threads.user_id = ${userId}`];

  if (status !== undefined) {
    parts.push(Prisma.sql`threads.status = ${status}`);
  }
  if (parentId !== undefined) {
    parts.push(parentId === null ? Prisma.sql`threads.parent_id IS NULL` : Prisma.sql`threads.parent_id = ${parentId}`);
  }
  if (projectId !== undefined) {
    parts.push(Prisma.sql`threads.project_id = ${projectId}`);
  }
  if (agent !== undefined) {
    parts.push(Prisma.sql`threads.agent = ${agent}`);
  }
  if (q !== undefined && q !== '') {
    const pattern = `%${escapeLike(q)}%`;

    parts.push(Prisma.sql`(threads.title ILIKE ${pattern} OR threads.description ILIKE ${pattern} OR threads.summary->>'text' ILIKE ${pattern})`);
  }
  if (createdAtGte !== undefined) {
    parts.push(Prisma.sql`threads.created_at >= ${createdAtGte}`);
  }
  if (createdAtLte !== undefined) {
    parts.push(Prisma.sql`threads.created_at <= ${createdAtLte}`);
  }
  if (beforeCreatedSeq !== undefined) {
    parts.push(Prisma.sql`threads.created_seq < ${beforeCreatedSeq}`);
  }

  return Prisma.join(parts, ' AND ');
}
