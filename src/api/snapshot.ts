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
import { SYSTEM_EXCEPTION, SYSTEM_RESTART_COMPLETED, SYSTEM_RESTART_REQUESTED, toEvent } from '../core/envelope.ts';
import { SESSION_VIEW_TYPES, foldSession } from '../projections/session.ts';
import { startedModel } from '../projections/last-model.ts';
import type { SessionView } from '../projections/session.ts';
import { getLatestTerminalThread, getThread, listThreads } from '../core/threads.ts';
import { readThreadWindow } from './thread-window.ts';
import { listProjects, projectView } from '../projects/store.ts';
import { listApps } from '../apps/management.ts';
import { publicAppsBase } from '../apps/urls.ts';
import { taskView } from '../schedule/view.ts';
import { connectionView, listUserConnections } from '../capabilities/connections/index.ts';
import { effectiveBundleServers, listUserAuthServers } from '../capabilities/tool-manager.ts';
import { readOpenSecretRequests } from '../capabilities/secret-requests.ts';
import { getAgents, isRemoteAgent, type CatalogAgent } from '../capabilities/agent-catalog.ts';
import { COORDINATOR_AGENT } from '../core/threads.ts';
import { COORDINATOR_BUNDLE, COORDINATOR_DESCRIPTION } from '../coordinator/functions.ts';
import { DEFAULT_EFFORT } from '../harness/default-effort.ts';
import { config } from '../config/index.ts';
import type { AgentDeclaration, RemoteAgentDeclaration } from '../core/contract.ts';
import type { AgentView, ConnectionView, MeResponse, ServiceView, SnapshotResponse, TaskView, SystemLogKind, SystemLogResponse } from './contract.ts';

export { SNAPSHOT_THREAD_WINDOW } from './thread-window.ts';

// The newest system.* events the snapshot carries; the console's system
// domain keeps as many (store/system/reducer.ts, KEEP).
export const SYSTEM_LOG_KEEP = 50;
export const SYSTEM_LOG_TYPES = [SYSTEM_EXCEPTION, SYSTEM_RESTART_REQUESTED, SYSTEM_RESTART_COMPLETED] as const;

async function readHeadSeq(): Promise<bigint> {
  const { _max } = await prisma.event.aggregate({ _max: { seq: true } });

  return _max.seq ?? 0n;
}

// The sessions behind the active threads of the window: the newest
// session.state, session.context and session.started of each (the model and
// effort the rail names), folded like the console folds the tail
// (src/projections/session.ts). A thread without session events has no
// entry — the client derives a state from the thread then.
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

// The system's own events as the stream shows them to this workspace —
// its own and the installation-level ones (userId null: a restart
// completed for no thread, an exception outside a workspace) — the newest
// SYSTEM_LOG_KEEP in seq order. The console's system domain folds the
// tail by the same rule (store/system/reducer.ts).
// The types a kind of the log page names (contract: SystemLogKind).
export function systemLogTypes(kind: SystemLogKind | undefined): string[] {
  return kind === 'restart' ? [SYSTEM_RESTART_REQUESTED, SYSTEM_RESTART_COMPLETED] : kind === 'exception' ? [SYSTEM_EXCEPTION] : [...SYSTEM_LOG_TYPES];
}

// A page of the same log for "Show more": the newest `limit` events of the
// kind before `before` (every one when null), in seq order, with the count
// of every event of the kind the workspace may see.
export async function readSystemLogPage(userId: string, kind: SystemLogKind | undefined, before: bigint | null, limit: number): Promise<SystemLogResponse> {
  const where = { type: { in: systemLogTypes(kind) }, OR: [{ userId }, { userId: null }] };
  const [rows, total] = await Promise.all([
    prisma.event.findMany({ where: { ...where, ...(before === null ? {} : { seq: { lt: before } }) }, orderBy: { seq: 'desc' }, take: limit }),
    prisma.event.count({ where }),
  ]);

  return { events: rows.reverse().map(toEvent), total };
}

export async function readSystemLog(userId: string): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: { type: { in: [...SYSTEM_LOG_TYPES] }, OR: [{ userId }, { userId: null }] },
    orderBy: { seq: 'desc' },
    take: SYSTEM_LOG_KEEP,
  });

  return rows.reverse().map(toEvent);
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

// The model each agent's newest session started with: the model of the
// agent's latest session.started in this workspace (the Claude journal
// writes it; Codex sessions have no such event). One DISTINCT ON over the
// session.started rows of the log (the (type, seq) index), the newest row's
// payload read by startedModel (src/projections/last-model.ts) — an agent
// whose newest start names no model is left without one. The tail keeps it
// fresh: the console's agents reducer folds session.started by the same
// rule (the stand test replays the tail over the snapshot and compares).
async function readLastModels(userId: string): Promise<Map<string, string | null>> {
  const rows = await prisma.$queryRaw<Array<{ agentName: string | null; payload: JsonObject }>>`
    SELECT DISTINCT ON (agent_name) agent_name AS "agentName", payload
    FROM events
    WHERE user_id = ${userId} AND type = 'session.started' AND agent_name IS NOT NULL
    ORDER BY agent_name, seq DESC`;
  const models = new Map<string, string | null>();

  for (const row of rows) {
    if (row.agentName) {
      models.set(row.agentName, startedModel(row.payload));
    }
  }

  return models;
}

// A remote agent kind: the session runs in an external system — no tool
// passport, no sub-agents, no model of ours; the options schema is the
// system's, shown nowhere yet.
function remoteAgentView(agent: RemoteAgentDeclaration): AgentView {
  return {
    name: agent.name,
    description: agent.description,
    icon: agent.icon ?? null,
    sdk: 'remote',
    tools: [],
    agents: [],
    headless: false,
    notification: agent.notification ?? null,
    model: null,
    effort: null,
    defaultEffort: null,
    lastModel: null,
  };
}

function agentView(agent: AgentDeclaration, lastModel: string | null): AgentView {
  return {
    name: agent.name,
    description: agent.description,
    icon: agent.icon ?? null,
    sdk: agent.sdk,
    tools: effectiveBundleServers(agent.tools),
    agents: agent.agents ?? [],
    headless: agent.headless ?? false,
    notification: agent.notification ?? null,
    model: agent.session?.model ?? null,
    effort: agent.session?.effort ?? null,
    // Both SDK sessions run with the platform default when the declaration
    // names no effort (src/harness/default-effort.ts).
    defaultEffort: DEFAULT_EFFORT,
    lastModel,
  };
}

// The coordinator — the secretary of the main thread — is not a catalog
// module (its loop is src/coordinator), so its view is built from its own
// facts: the OpenAI backend and the model of the config, the tool servers of
// its passport (with the extension servers its "projects" brings), every catalog agent as what it launches (its spawn functions
// derive from the whole catalog). Its requests name no reasoning effort and
// its turns journal no session.started — effort, defaultEffort and
// lastModel stay null.
function coordinatorView(catalog: CatalogAgent[]): AgentView {
  return {
    name: COORDINATOR_AGENT,
    description: COORDINATOR_DESCRIPTION,
    icon: null,
    sdk: 'openai',
    tools: effectiveBundleServers(COORDINATOR_BUNDLE.declared),
    agents: catalog.map(agent => agent.name),
    headless: false,
    notification: null,
    model: config.mainOpenaiModel,
    effort: null,
    defaultEffort: null,
    lastModel: null,
  };
}

// The agents as the console's catalog shows them: the coordinator first,
// then the catalog by name (getAgents sorts), each with the model its
// newest session ran on.
export async function readAgents(userId: string): Promise<AgentView[]> {
  const catalog = getAgents();
  const lastModels = await readLastModels(userId);

  return [
    coordinatorView(catalog),
    ...catalog.map(agent => (isRemoteAgent(agent) ? remoteAgentView(agent) : agentView(agent, lastModels.get(agent.name) ?? null))),
  ];
}

export async function buildSnapshot(userId: string, readMe: () => Promise<MeResponse>): Promise<SnapshotResponse> {
  // The stamp first, the projections after: the tail from asOfSeq may
  // overlap with what the projections already reflect, never miss anything.
  // `me` is a projection too (settings.updated changes its names), so it is
  // read here, after the stamp — not by the caller before it.
  const asOfSeq = await readHeadSeq();
  const now = new Date();
  const me = await readMe();

  const [threads, mainLastMessage, projects, apps, tasks, connections, secretRequests, agents, systemLog] = await Promise.all([
    readThreadWindow(userId, me.mainThreadId, { list: listThreads, get: getThread, latestTerminal: getLatestTerminalThread }),
    readMainLastMessage(me.mainThreadId),
    listProjects(userId),
    listApps(userId),
    readTasks(userId, now),
    readConnections(userId),
    readOpenSecretRequests(userId),
    readAgents(userId),
    readSystemLog(userId),
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
    secretRequests,
    agents,
    systemLog,
  };
}
