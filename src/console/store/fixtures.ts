// Fixtures for the store tests: events in the payload forms of the log
// (server.md), threads as the API returns them, a minimal snapshot.

import type { Event, Thread } from '../../core/contract.ts';
import type { SnapshotResponse } from '../../api/contract.ts';

let nextSeq = 1n;

export function resetSeq(seq = 1n): void {
  nextSeq = seq;
}

export function event(partial: Partial<Event> & { type: string }): Event {
  const seq = partial.seq ?? nextSeq++;

  return {
    seq,
    id: partial.id ?? `ev-${seq}`,
    actor: partial.actor ?? 'agent',
    agentName: partial.agentName ?? (partial.actor === 'user' || partial.actor === 'system' ? null : 'engineer'),
    userId: partial.userId ?? 'u1',
    threadId: partial.threadId ?? null,
    targetThreadId: partial.targetThreadId ?? null,
    payload: partial.payload ?? {},
    schemaVersion: partial.schemaVersion ?? 1,
    createdAt: partial.createdAt ?? new Date(1_700_000_000_000 + Number(seq) * 1000),
    type: partial.type,
  };
}

export function thread(partial: Partial<Thread> & { id: string }): Thread {
  const createdAt = partial.createdAt ?? new Date(1_700_000_000_000);

  return {
    userId: 'u1',
    parentId: 'main',
    agent: 'engineer',
    title: null,
    description: null,
    status: 'active',
    summary: null,
    projectId: null,
    headless: false,
    createdSeq: 1n,
    terminalSeq: null,
    createdAt,
    updatedAt: partial.updatedAt ?? createdAt,
    ...partial,
  };
}

export const ME = { userId: 'u1', workspaceName: 'Workspace', operatorName: null, mainThreadId: 'main' };

export function snapshot(partial: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    asOfSeq: 100n,
    me: ME,
    threads: [],
    mainLastMessage: null,
    sessions: {},
    projects: [],
    apps: { apps: [], publicAppsBase: 'https://apps.example' },
    tasks: [],
    connections: [],
    services: [],
    agents: [],
    ...partial,
  };
}
