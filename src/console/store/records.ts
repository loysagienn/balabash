// The registry rows as the events carry them (ISO dates, the field names
// of the connection.* family) → the views of the snapshot the domains
// store. Tolerant of history: a record without its id, or with a date that
// does not parse, is skipped (null) rather than folded in broken.

import type { ConnectionView, OpenSecretRequestView, ProjectView, TaskView } from '../../api/contract.ts';
import type { ConnectionRecord, ProjectRecord, SecretRequestRecord, TaskRecord } from '../../core/event-types.ts';

function date(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function projectFromRecord(record: Partial<ProjectRecord>): ProjectView | null {
  const createdAt = date(record.createdAt);
  const updatedAt = date(record.updatedAt);

  if (!record.id || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id: record.id,
    title: record.title ?? '',
    slug: record.slug ?? '',
    description: record.description ?? '',
    archived: record.archived ?? false,
    // A record written before the date was carried has none: no date.
    archivedAt: date(record.archivedAt),
    createdAt,
    updatedAt,
  };
}

export function taskFromRecord(record: Partial<TaskRecord>): TaskView | null {
  const createdAt = date(record.createdAt);

  if (!record.id || !record.slug || !createdAt) {
    return null;
  }

  return {
    id: record.id,
    slug: record.slug,
    name: record.name ?? record.slug,
    description: str(record.description),
    kind: record.kind ?? 'note',
    cron: str(record.cron),
    at: date(record.at),
    note: str(record.note),
    command: str(record.command),
    cwd: str(record.cwd),
    timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : null,
    reportOnSuccess: record.reportOnSuccess ?? false,
    createdBy: str(record.createdBy),
    createdAt,
    nextRunAt: date(record.nextRunAt),
  };
}

export function connectionFromRecord(record: Partial<ConnectionRecord>): ConnectionView | null {
  const createdAt = date(record.createdAt);
  const updatedAt = date(record.updatedAt);

  if (!record.connectionId || !record.server || !record.account || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id: record.connectionId,
    server: record.server,
    accountKey: record.account,
    displayName: record.name ?? record.account,
    status: record.status ?? 'pending',
    identity: str(record.identity),
    scope: str(record.scope),
    threadId: str(record.threadId),
    createdAt,
    updatedAt,
  };
}

// The open request as secrets.requested / oauth_client.requested carry it:
// the kind is the event's type, the asking thread and agent are the
// event's author (its threadId and agentName), the moment is the record's
// (the row's) — the event's own when the record carries none.
export function secretRequestFromRecord(kind: OpenSecretRequestView['kind'], record: Partial<SecretRequestRecord>, author: { threadId: string | null; agentName: string | null; createdAt: Date }): OpenSecretRequestView | null {
  if (!record.requestId || !record.server) {
    return null;
  }

  return {
    id: record.requestId,
    kind,
    server: record.server,
    fields: Array.isArray(record.fields) ? record.fields.filter((field): field is string => typeof field === 'string') : [],
    threadId: author.threadId,
    agent: author.agentName,
    requestedAt: date(record.requestedAt) ?? author.createdAt,
  };
}
