// GET /api/snapshot — the console's starting state: the server-side
// projections of the workspace, read after stamping the log position they
// are at least as fresh as. The client hydrates its store from this and
// continues with the event stream from asOfSeq: anything written while the
// projections were being read arrives again through the tail (reducers are
// idempotent by seq), nothing is skipped.
//
// Everything here is derivable from events — the invariant that lets the
// tail keep it fresh. Measurements (telemetry, file listings, usage) are
// not in the snapshot; they have their own endpoints.

import { Prisma } from '../../prisma-generated/client.ts';
import { prisma } from '../db/client.ts';
import type { JsonObject, Thread } from '../core/contract.ts';
import { SESSION_VIEW_TYPES, foldSession } from '../projections/session.ts';
import type { SessionView } from '../projections/session.ts';
import { listThreads } from '../core/threads.ts';
import { listProjects } from '../projects/store.ts';
import { listApps } from '../apps/management.ts';
import { publicAppsBase } from '../apps/urls.ts';
import { cronNextRun } from '../schedule/heart.ts';
import { listUserConnections } from '../capabilities/connections/index.ts';
import { identityLabel } from '../capabilities/connections/identity.ts';
import { listUserAuthServers } from '../capabilities/tool-manager.ts';
import { getAgents } from '../capabilities/agent-catalog.ts';
import type { AgentView, ConnectionView, MeResponse, ServiceView, SnapshotResponse, TaskView } from './contract.ts';

// The newest threads kept in the snapshot next to every active one; older
// history pages in through GET /api/threads.
export const SNAPSHOT_THREAD_WINDOW = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readHeadSeq(): Promise<bigint> {
  const { _max } = await prisma.event.aggregate({ _max: { seq: true } });

  return _max.seq ?? 0n;
}

async function readThreadWindow(userId: string): Promise<Thread[]> {
  const [active, newest] = await Promise.all([
    listThreads(userId, { status: 'active', limit: 500, order: 'desc' }),
    listThreads(userId, { limit: SNAPSHOT_THREAD_WINDOW, order: 'desc' }),
  ]);
  const byId = new Map<string, Thread>();

  for (const thread of [...active, ...newest]) {
    byId.set(thread.id, thread);
  }

  return [...byId.values()].sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : a.createdSeq < b.createdSeq ? 1 : 0));
}

// The sessions behind the active threads of the window: the newest
// session.state and session.context of each, folded like the console folds
// the tail (src/projections/session.ts). A thread without session events
// has no entry — the client derives a state from the thread then.
async function readSessions(threads: Thread[]): Promise<Record<string, SessionView>> {
  const activeIds = threads.filter(thread => thread.status === 'active').map(thread => thread.id);
  const sessions: Record<string, SessionView> = {};

  if (!activeIds.length) {
    return sessions;
  }

  const rows = await prisma.$queryRaw<Array<{ threadId: string; type: string; payload: JsonObject }>>`
    SELECT DISTINCT ON (thread_id, type) thread_id AS "threadId", type, payload
    FROM events
    WHERE thread_id IN (${Prisma.join(activeIds)}) AND type IN (${Prisma.join([...SESSION_VIEW_TYPES])})
    ORDER BY thread_id, type, seq DESC`;

  for (const row of rows) {
    const view = foldSession(sessions[row.threadId] ?? null, row.type, row.payload);

    if (view) {
      sessions[row.threadId] = view;
    }
  }

  return sessions;
}

async function readTasks(userId: string, now: Date): Promise<TaskView[]> {
  const rows = await prisma.scheduledTask.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  return rows.map(row => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    cron: row.cron,
    at: row.at,
    note: row.note,
    command: row.command,
    cwd: row.cwd,
    timeoutMs: row.timeoutMs,
    reportOnSuccess: row.reportOnSuccess,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    nextRunAt: row.cron ? safeNextRun(row.cron, now) : row.at,
  }));
}

function safeNextRun(cron: string, now: Date): Date | null {
  try {
    return cronNextRun(cron, now);
  } catch {
    return null;
  }
}

async function readConnections(userId: string): Promise<ConnectionView[]> {
  const rows = await listUserConnections(userId);

  return rows.map(row => ({
    id: row.id,
    server: row.server,
    accountKey: row.accountKey,
    displayName: row.displayName,
    status: row.status,
    identity: identityLabel(row.identity),
    scope: isObject(row.metadata) && typeof row.metadata.scope === 'string' ? row.metadata.scope : null,
    threadId: row.threadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function readServices(): ServiceView[] {
  return listUserAuthServers().map(server => ({
    name: server.name,
    description: server.description || null,
    multiAccount: server.identityProbe !== null,
    manualClient: server.clientRegistration === 'manual',
  }));
}

function readAgents(): AgentView[] {
  return getAgents().map(agent => ({
    name: agent.name,
    description: agent.description,
    icon: agent.icon ?? null,
    sdk: agent.sdk,
    tools: agent.tools,
    agents: agent.agents ?? [],
    headless: agent.headless ?? false,
    notification: agent.notification ?? null,
    model: agent.session?.model ?? null,
    effort: agent.session?.effort ?? null,
  }));
}

export async function buildSnapshot(userId: string, me: MeResponse): Promise<SnapshotResponse> {
  // The stamp first, the projections after: the tail from asOfSeq may
  // overlap with what the projections already reflect, never miss anything.
  const asOfSeq = await readHeadSeq();
  const now = new Date();

  const [threads, projects, apps, tasks, connections] = await Promise.all([
    readThreadWindow(userId),
    listProjects(userId),
    listApps(userId),
    readTasks(userId, now),
    readConnections(userId),
  ]);
  const sessions = await readSessions(threads);

  return {
    asOfSeq,
    me,
    threads,
    sessions,
    projects: projects.map(project => ({
      id: project.id,
      title: project.title,
      slug: project.slug,
      description: project.description,
      archived: project.archived,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    apps: { apps, publicAppsBase: publicAppsBase() },
    tasks,
    connections,
    services: readServices(),
    agents: readAgents(),
  };
}
