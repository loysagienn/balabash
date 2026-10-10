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
import type { Event, JsonObject, Thread } from '../core/contract.ts';
import { toEvent } from '../core/envelope.ts';
import { SESSION_VIEW_TYPES, foldSession } from '../projections/session.ts';
import type { SessionView } from '../projections/session.ts';
import { getLatestTerminalThread, getThread, listThreads } from '../core/threads.ts';
import { readThreadWindow } from './thread-window.ts';
import { listProjects, projectView } from '../projects/store.ts';
import { listApps } from '../apps/management.ts';
import { publicAppsBase } from '../apps/urls.ts';
import { taskView } from '../schedule/view.ts';
import { connectionView, listUserConnections } from '../capabilities/connections/index.ts';
import { listUserAuthServers } from '../capabilities/tool-manager.ts';
import { getAgents } from '../capabilities/agent-catalog.ts';
import type { AgentView, ConnectionView, MeResponse, ServiceView, SnapshotResponse, TaskView } from './contract.ts';

export { SNAPSHOT_THREAD_WINDOW } from './thread-window.ts';

async function readHeadSeq(): Promise<bigint> {
  const { _max } = await prisma.event.aggregate({ _max: { seq: true } });

  return _max.seq ?? 0n;
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

// The newest message of the main thread's feed — a user.message or an
// agent.message authored in it or addressed to it, the feed's own selection
// (src/core/events.ts listThreadEvents) — for its pinned row in the Threads
// list before the thread is opened. Null while the thread has none.
export async function readMainLastMessage(mainThreadId: string | null): Promise<Event | null> {
  if (mainThreadId === null) {
    return null;
  }

  const row = await prisma.event.findFirst({
    where: { OR: [{ threadId: mainThreadId }, { targetThreadId: mainThreadId }], type: { in: ['user.message', 'agent.message'] } },
    orderBy: { seq: 'desc' },
  });

  return row ? toEvent(row) : null;
}

async function readTasks(userId: string, now: Date): Promise<TaskView[]> {
  const rows = await prisma.scheduledTask.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  return rows.map(row => taskView(row, now));
}

async function readConnections(userId: string): Promise<ConnectionView[]> {
  return (await listUserConnections(userId)).map(connectionView);
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

  const [threads, mainLastMessage, projects, apps, tasks, connections] = await Promise.all([
    readThreadWindow(userId, me.mainThreadId, { list: listThreads, get: getThread, latestTerminal: getLatestTerminalThread }),
    readMainLastMessage(me.mainThreadId),
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
    mainLastMessage,
    sessions,
    projects: projects.map(projectView),
    apps: { apps, publicAppsBase: publicAppsBase() },
    tasks,
    connections,
    services: readServices(),
    agents: readAgents(),
  };
}
