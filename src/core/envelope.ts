// Event envelope: canonical types, domain-type rules and append input
// validation that needs no database access (design doc §4.2).

import { z } from 'zod';
import type { Event, EventActor, JsonObject } from './contract.ts';
import type { EventModel as EventRow } from '../../prisma-generated/models.ts';

export const THREAD_STARTED = 'thread.started';
export const THREAD_PROGRESS = 'thread.progress';
export const THREAD_COMPLETED = 'thread.completed';
export const THREAD_FAILED = 'thread.failed';
export const THREAD_CANCELLED = 'thread.cancelled';
export const THREAD_CANCEL = 'thread.cancel';
export const THREAD_MESSAGE = 'thread.message';
export const THREAD_NOTIFICATION = 'thread.notification';
export const SYSTEM_EXCEPTION = 'system.exception';
export const SYSTEM_RESTART_REQUESTED = 'system.restart.requested';
export const SYSTEM_RESTART_COMPLETED = 'system.restart.completed';
export const OAUTH_CLIENT_PROVISIONED = 'oauth_client.provisioned';
export const SECRETS_PROVISIONED = 'secrets.provisioned';
export const CONNECTION_COMPLETED = 'connection.completed';
export const CONNECTION_FAILED = 'connection.failed';
export const CONNECTION_REAUTHORIZATION_REQUIRED = 'connection.reauthorization_required';
export const SCHEDULE_FIRED = 'schedule.fired';

// A thread is terminated by exactly one of these; the first one wins.
export const TERMINAL_TYPES: ReadonlySet<string> = new Set([THREAD_COMPLETED, THREAD_FAILED, THREAD_CANCELLED]);

const CANONICAL_TYPES: ReadonlySet<string> = new Set([
  'user.message',
  'agent.message',
  THREAD_STARTED,
  THREAD_PROGRESS,
  THREAD_COMPLETED,
  THREAD_FAILED,
  THREAD_CANCELLED,
  THREAD_CANCEL,
  THREAD_MESSAGE,
  THREAD_NOTIFICATION,
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  OAUTH_CLIENT_PROVISIONED,
  SECRETS_PROVISIONED,
  SYSTEM_EXCEPTION,
  // Restart-based self-extension: a request written by the restart consent
  // tool, and the completion the fresh process reports to the requester.
  SYSTEM_RESTART_REQUESTED,
  SYSTEM_RESTART_COMPLETED,
  // A scheduled task firing: written by the schedule heart (actor system,
  // no author thread) and addressed to the workspace's main thread — the
  // coordinator interprets the content.
  SCHEDULE_FIRED,
]);

// Sanitized integration lifecycle events (connection.connected, …) form an
// open family: concrete suffixes belong to the connections layer (stage 4).
const CANONICAL_FAMILIES = ['connection.'];

// First segments owned by the canonical vocabulary. A domain event's first
// segment (= agent name) must not collide with them.
export const RESERVED_DOMAINS: ReadonlySet<string> = new Set([
  'user',
  'agent',
  'thread',
  'tool',
  'connection',
  'system',
  'capability',
  'oauth_client',
  'secrets',
  'schedule',
]);

const DOMAIN_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type AppendInput = {
  type: string;
  actor: EventActor;
  agentName?: string | null;
  userId: string | null;
  threadId?: string | null;
  // For thread lifecycle events the target is derived from the projection
  // (parent); passing it explicitly is allowed but must match.
  targetThreadId?: string | null;
  payload: JsonObject;
  schemaVersion?: number;
};

export class AppendError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppendError';
    this.code = code;
  }
}

export function isCanonicalType(type: string): boolean {
  return CANONICAL_TYPES.has(type) || CANONICAL_FAMILIES.some(prefix => type.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Lifecycle payload schemas

export const summarySchema = z.object({
  text: z.string(),
  fileIds: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(), // Event.id references
});

export const threadStartedPayloadSchema = z.looseObject({
  agent: z.string().min(1),
  title: z.string().optional(),
  input: z.unknown().optional(),
});

// Addressed inter-thread message (§5.1): one hop, parent ↔ child. Text plus
// optional file references — files always travel between threads as fileIds
// into the shared store, never as inline bytes.
export const threadMessagePayloadSchema = z.looseObject({
  text: z.string().min(1),
  fileIds: z.array(z.string()).optional(),
});

// A completed thread describes itself retrospectively: the corrected title
// (2–5 words naming the work) and a ~300-char description ride the terminal
// alongside the full summary. Optional at the envelope — the core stays
// tolerant to log history; strictness lives at the end_thread tool edge.
export const threadCompletedPayloadSchema = z.looseObject({
  summary: summarySchema,
  title: z.string().optional(),
  description: z.string().optional(),
});
export const threadFailedPayloadSchema = z.looseObject({ error: z.string() });
export const threadCancelledPayloadSchema = z.looseObject({ reason: z.string() });
export const threadNotificationPayloadSchema = z.looseObject({
  level: z.enum(['silent', 'normal', 'urgent']),
  text: z.string(),
});

const LIFECYCLE_PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  [THREAD_STARTED]: threadStartedPayloadSchema,
  [THREAD_MESSAGE]: threadMessagePayloadSchema,
  [THREAD_COMPLETED]: threadCompletedPayloadSchema,
  [THREAD_FAILED]: threadFailedPayloadSchema,
  [THREAD_CANCELLED]: threadCancelledPayloadSchema,
  [THREAD_NOTIFICATION]: threadNotificationPayloadSchema,
};

// ---------------------------------------------------------------------------
// Database-free validation. Thread existence, one-hop and terminal rules need
// the projection and live in append.ts.

export function validateEnvelope(input: AppendInput): void {
  const { type, actor, agentName, userId, threadId } = input;

  if (isCanonicalType(type)) {
    validateCanonicalActor(input);
  } else {
    // Domain event '<agent>.*': published by the agent itself (§4.2).
    if (!DOMAIN_TYPE_RE.test(type)) {
      throw new AppendError('invalid_type', `Event type "${type}" is neither canonical nor a valid domain type`);
    }

    const domain = type.split('.', 1)[0]!;

    if (RESERVED_DOMAINS.has(domain)) {
      throw new AppendError('invalid_type', `Event type "${type}" uses reserved domain "${domain}"`);
    }

    if (actor !== 'agent' || agentName !== domain) {
      throw new AppendError(
        'actor_mismatch',
        `Domain event "${type}" must be published by actor 'agent' named "${domain}"`,
      );
    }
  }

  if (actor === 'agent') {
    if (!agentName) {
      throw new AppendError('actor_mismatch', `actor 'agent' requires agentName (type "${type}")`);
    }
  } else if (agentName) {
    throw new AppendError('actor_mismatch', `agentName "${agentName}" is only valid for actor 'agent'`);
  }

  // Installation-level events live outside workspaces and therefore outside
  // threads: threads always belong to a user.
  if (threadId && !userId) {
    throw new AppendError('user_required', `Event with threadId requires userId (type "${type}")`);
  }

  const payloadSchema = LIFECYCLE_PAYLOAD_SCHEMAS[type];

  if (payloadSchema) {
    const result = payloadSchema.safeParse(input.payload);

    if (!result.success) {
      throw new AppendError('invalid_payload', `Invalid payload for "${type}": ${result.error.message}`);
    }
  }
}

function validateCanonicalActor(input: AppendInput): void {
  const { type, actor, threadId } = input;

  if (type === 'user.message' && actor !== 'user') {
    throw new AppendError('actor_mismatch', `user.message requires actor 'user'`);
  }

  if (type === 'agent.message' && actor !== 'agent') {
    throw new AppendError('actor_mismatch', `agent.message requires actor 'agent'`);
  }

  const requiresThread = ['user.message', 'agent.message', THREAD_NOTIFICATION, THREAD_PROGRESS, THREAD_MESSAGE];
  const isToolCall = type.startsWith('tool.call.');

  if (
    (requiresThread.includes(type) ||
      isToolCall ||
      TERMINAL_TYPES.has(type) ||
      type === THREAD_STARTED ||
      type === THREAD_CANCEL) &&
    !threadId
  ) {
    throw new AppendError('thread_required', `Event "${type}" requires threadId`);
  }

  // An inter-thread message without an addressee is meaningless; the one-hop
  // rule (append) then holds it to parent ↔ direct child.
  if (type === THREAD_MESSAGE && !input.targetThreadId) {
    throw new AppendError('target_required', 'thread.message requires targetThreadId');
  }
}

// ---------------------------------------------------------------------------

export function toEvent(row: EventRow): Event {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    actor: row.actor as EventActor,
    agentName: row.agentName,
    userId: row.userId,
    threadId: row.threadId,
    targetThreadId: row.targetThreadId,
    payload: row.payload as JsonObject,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
  };
}
