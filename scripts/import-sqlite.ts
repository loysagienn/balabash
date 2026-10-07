// One-off import of the SQLite database of the CCR fork (loysagienn/
// balabash-claude) into this installation's Postgres. Offline by contract: the app is not
// running against the target, the target is EMPTY (fresh `prisma migrate
// deploy`), the source is a stopped fork's database or a `VACUUM INTO`
// snapshot of it. The source is only ever read (node:sqlite, read-only).
//
// Usage: npm run build && npm run import-sqlite -- <path/to/balabash.db> [options]
//   --files-root <dir>    the fork's FILES_ROOT, the prefix files.path rows are
//                         relative to; default <dir of db>/../files
//   --skip-connections    leave connections/oauth_clients out (reconnect later)
//
// What goes where (the table in the document is the spec; the code is the
// truth):
//   users                  as is, same ids — data/workspace/<userId> and
//                          data/agent-state move without renames
//   events                 row by row, seq preserved, payload text → jsonb;
//                          the seq sequence is bumped past max(seq)
//   threads                NOT copied: the projection is rebuilt from the log
//   ccr_sessions/_deliveries  copied, except the rows of main threads: the
//                          coordinator has no Claude Code session here
//   projects, scheduled_tasks  copied (new columns take their defaults)
//   files                  path → (bucket 'local', objectKey relative to the
//                          fork's files root): the local storage driver
//   connections            copied onto the account axis: accountKey 'default',
//                          displayName = server (how the first account of a
//                          server is born here); oauth_clients as is
//   event_consumers        NOT copied: every consumer of this code base
//                          starts at max(seq) — nothing is replayed
//   web_sessions           NOT copied (the operator logs in again)
//
// Everything — the threads projection included — is written in one
// transaction: a failure leaves the target empty, fix the cause and rerun.
// Only the verification runs after the commit (read-only).

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prisma } from '../src/db/client.ts';
import { rebuildThreadsProjection } from '../src/core/threads.ts';
import { Prisma } from '../prisma-generated/client.ts';

// Consumer names of this code base (src/core/consumers.ts callers). Without
// a row a consumer starts at lastSeq 0 and replays the whole imported log
// (ccr-delivery alone registers at the head) — here every one starts after
// the last event.
const CONSUMER_NAMES = ['thread-router', 'ccr-delivery', 'restart', 'reauth-detector', 'telegram-delivery'];

const EVENT_BATCH = 200;
const TRANSACTION_TIMEOUT_MS = 15 * 60 * 1000;

type Row = Record<string, unknown>;

function usage(message?: string): never {
  if (message) {
    console.error(`[import-sqlite] ${message}`);
  }

  console.error('Usage: npm run import-sqlite -- <path/to/balabash.db> [--files-root <dir>] [--skip-connections]');
  process.exit(2);
}

function parseArgs(argv: string[]): { dbPath: string; filesRoot: string; skipConnections: boolean } {
  let dbPath: string | undefined;
  let filesRoot: string | undefined;
  let skipConnections = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--files-root') {
      filesRoot = argv[i + 1] ?? usage('--files-root needs a directory');
      i += 1;
    } else if (arg === '--skip-connections') {
      skipConnections = true;
    } else if (arg.startsWith('--')) {
      usage(`unknown option ${arg}`);
    } else if (dbPath === undefined) {
      dbPath = arg;
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }

  if (!dbPath) {
    usage();
  }

  const resolvedDb = path.resolve(dbPath);

  return {
    dbPath: resolvedDb,
    filesRoot: path.resolve(filesRoot ?? path.join(path.dirname(resolvedDb), '..', 'files')),
    skipConnections,
  };
}

function str(row: Row, column: string): string {
  const value = row[column];

  if (typeof value !== 'string') {
    throw new Error(`column ${column}: expected text, got ${typeof value} (${JSON.stringify(value)})`);
  }

  return value;
}

function optStr(row: Row, column: string): string | null {
  const value = row[column];

  return value === null || value === undefined ? null : str(row, column);
}

function int(row: Row, column: string): number {
  const value = row[column];

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`column ${column}: expected integer, got ${JSON.stringify(value)}`);
  }

  return value;
}

function optInt(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : int(row, column);
}

function bool(row: Row, column: string): boolean {
  return int(row, column) !== 0;
}

// The fork stores dates as ISO-8601 text with a zone ('2026-08-12T10:25:39.080+00:00').
function date(row: Row, column: string): Date {
  const value = str(row, column);
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`column ${column}: not a date: ${value}`);
  }

  return parsed;
}

function optDate(row: Row, column: string): Date | null {
  return row[column] === null || row[column] === undefined ? null : date(row, column);
}

// The fork's JSON columns are declared JSONB by Prisma's SQLite connector but
// hold JSON text.
function json(row: Row, column: string): Prisma.InputJsonValue {
  const value = str(row, column);

  return JSON.parse(value) as Prisma.InputJsonValue;
}

function optJson(row: Row, column: string): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return row[column] === null || row[column] === undefined ? Prisma.DbNull : json(row, column);
}

// jsonb does not keep key order — compare canonical renderings.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function sqliteRows(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function sqliteCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number | bigint };

  return Number(row.c);
}

async function assertTargetEmpty(): Promise<void> {
  const counts = {
    users: await prisma.user.count(),
    events: await prisma.event.count(),
    threads: await prisma.thread.count(),
    ccr_sessions: await prisma.ccrSession.count(),
    ccr_deliveries: await prisma.ccrDelivery.count(),
    connections: await prisma.connection.count(),
    oauth_clients: await prisma.oauthClient.count(),
    projects: await prisma.project.count(),
    scheduled_tasks: await prisma.scheduledTask.count(),
    files: await prisma.file.count(),
    event_consumers: await prisma.eventConsumer.count(),
  };
  const nonEmpty = Object.entries(counts).filter(([, count]) => count > 0);

  if (nonEmpty.length) {
    throw new Error(
      `target database is not empty: ${nonEmpty.map(([table, count]) => `${table}=${count}`).join(', ')} — ` +
        'the import expects a fresh `prisma migrate deploy`',
    );
  }
}

const { dbPath, filesRoot, skipConnections } = parseArgs(process.argv.slice(2));

console.log(`[import-sqlite] source ${dbPath}`);
console.log(`[import-sqlite] files root ${filesRoot}`);

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  await assertTargetEmpty();

  const source = {
    users: sqliteCount(db, 'users'),
    events: sqliteCount(db, 'events'),
    threads: sqliteCount(db, 'threads'),
    ccr_sessions: sqliteCount(db, 'ccr_sessions'),
    ccr_deliveries: sqliteCount(db, 'ccr_deliveries'),
    connections: sqliteCount(db, 'connections'),
    oauth_clients: sqliteCount(db, 'oauth_clients'),
    projects: sqliteCount(db, 'projects'),
    scheduled_tasks: sqliteCount(db, 'scheduled_tasks'),
    files: sqliteCount(db, 'files'),
  };

  console.log(`[import-sqlite] source rows: ${JSON.stringify(source)}`);

  const maxSeqRow = db.prepare('SELECT max(seq) AS m FROM events').get() as { m: number | bigint | null };
  const maxSeq = maxSeqRow.m === null ? 0 : Number(maxSeqRow.m);

  if (source.users === 0 || maxSeq === 0) {
    throw new Error('source database has no users or no events — nothing to import');
  }

  // Main threads: thread.started with no addressee. Their CCR rows stay behind.
  const mainThreadIds = new Set(
    sqliteRows(db, "SELECT thread_id FROM events WHERE type = 'thread.started' AND target_thread_id IS NULL").map(row =>
      str(row, 'thread_id'),
    ),
  );
  const skippedCcr = sqliteRows(db, 'SELECT thread_id, cse_id FROM ccr_sessions').filter(row =>
    mainThreadIds.has(str(row, 'thread_id')),
  );
  const skippedCseIds = new Set(skippedCcr.map(row => str(row, 'cse_id')));

  let projection = { threads: 0, terminals: 0 };
  const stats = {
    users: 0,
    events: 0,
    ccr_sessions: 0,
    ccr_deliveries: 0,
    connections: 0,
    oauth_clients: 0,
    projects: 0,
    scheduled_tasks: 0,
    files: 0,
    event_consumers: 0,
  };

  await prisma.$transaction(
    async tx => {
      // users
      for (const row of sqliteRows(db, 'SELECT * FROM users')) {
        await tx.user.create({
          data: { id: str(row, 'id'), createdAt: date(row, 'created_at'), updatedAt: date(row, 'updated_at') },
        });
        stats.users += 1;
      }

      // events, in seq order and batches
      const select = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?');
      let cursor = 0;

      for (;;) {
        const rows = select.all(cursor, EVENT_BATCH) as Row[];

        if (rows.length === 0) {
          break;
        }

        await tx.event.createMany({
          data: rows.map(row => ({
            seq: BigInt(int(row, 'seq')),
            id: str(row, 'id'),
            type: str(row, 'type'),
            actor: str(row, 'actor'),
            agentName: optStr(row, 'agent_name'),
            userId: optStr(row, 'user_id'),
            threadId: optStr(row, 'thread_id'),
            targetThreadId: optStr(row, 'target_thread_id'),
            payload: json(row, 'payload'),
            schemaVersion: int(row, 'schema_version'),
            createdAt: date(row, 'created_at'),
          })),
        });

        stats.events += rows.length;
        cursor = int(rows[rows.length - 1], 'seq');

        if (stats.events % 1000 === 0 || rows.length < EVENT_BATCH) {
          console.log(`[import-sqlite] events ${stats.events}/${source.events}`);
        }
      }

      // The autoincrement sequence continues after the imported log.
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('events', 'seq'), ${maxSeq}::bigint, true)`;

      // ccr_sessions / ccr_deliveries, minus the main threads'
      for (const row of sqliteRows(db, 'SELECT * FROM ccr_sessions')) {
        if (mainThreadIds.has(str(row, 'thread_id'))) {
          continue;
        }

        await tx.ccrSession.create({
          data: {
            threadId: str(row, 'thread_id'),
            cseId: str(row, 'cse_id'),
            seqCursor: int(row, 'seq_cursor'),
            archivedAt: optDate(row, 'archived_at'),
            createdAt: date(row, 'created_at'),
            updatedAt: date(row, 'updated_at'),
          },
        });
        stats.ccr_sessions += 1;
      }

      for (const row of sqliteRows(db, 'SELECT * FROM ccr_deliveries')) {
        if (skippedCseIds.has(str(row, 'cse_id'))) {
          continue;
        }

        await tx.ccrDelivery.create({
          data: {
            id: str(row, 'id'),
            eventId: str(row, 'event_id'),
            cseId: str(row, 'cse_id'),
            createdAt: date(row, 'created_at'),
          },
        });
        stats.ccr_deliveries += 1;
      }

      // projects
      for (const row of sqliteRows(db, 'SELECT * FROM projects')) {
        await tx.project.create({
          data: {
            id: str(row, 'id'),
            userId: str(row, 'user_id'),
            title: str(row, 'title'),
            slug: str(row, 'slug'),
            description: str(row, 'description'),
            archived: bool(row, 'archived'),
            createdAt: date(row, 'created_at'),
            updatedAt: date(row, 'updated_at'),
          },
        });
        stats.projects += 1;
      }

      // scheduled_tasks (the fork knows kinds note | code; command columns default)
      for (const row of sqliteRows(db, 'SELECT * FROM scheduled_tasks')) {
        await tx.scheduledTask.create({
          data: {
            id: str(row, 'id'),
            slug: str(row, 'slug'),
            userId: str(row, 'user_id'),
            name: str(row, 'name'),
            description: optStr(row, 'description'),
            kind: str(row, 'kind'),
            cron: optStr(row, 'cron'),
            at: optDate(row, 'at'),
            note: optStr(row, 'note'),
            createdBy: optStr(row, 'created_by'),
            createdAt: date(row, 'created_at'),
          },
        });
        stats.scheduled_tasks += 1;
      }

      // files: absolute path → local driver key
      const rootPrefix = `${filesRoot}${path.sep}`;

      for (const row of sqliteRows(db, 'SELECT * FROM files')) {
        const filePath = str(row, 'path');

        if (!filePath.startsWith(rootPrefix)) {
          throw new Error(`files.path "${filePath}" is not under the files root ${filesRoot} (use --files-root)`);
        }

        await tx.file.create({
          data: {
            id: str(row, 'id'),
            bucket: 'local',
            objectKey: filePath.slice(rootPrefix.length),
            userId: optStr(row, 'user_id'),
            contentType: optStr(row, 'content_type'),
            sizeBytes: optInt(row, 'size_bytes'),
            etag: optStr(row, 'etag'),
            originalFilename: optStr(row, 'original_filename'),
            scope: optStr(row, 'scope'),
            width: optInt(row, 'width'),
            height: optInt(row, 'height'),
            uploadedAt: optDate(row, 'uploaded_at'),
            createdAt: date(row, 'created_at'),
            updatedAt: date(row, 'updated_at'),
          },
        });
        stats.files += 1;
      }

      // connections / oauth_clients
      if (!skipConnections) {
        for (const row of sqliteRows(db, 'SELECT * FROM connections')) {
          const server = str(row, 'server');

          await tx.connection.create({
            data: {
              id: str(row, 'id'),
              userId: str(row, 'user_id'),
              threadId: optStr(row, 'thread_id'),
              server,
              accountKey: 'default',
              displayName: server,
              status: str(row, 'status'),
              pendingState: optStr(row, 'pending_state'),
              pending: optJson(row, 'pending'),
              tokens: optJson(row, 'tokens'),
              metadata: optJson(row, 'metadata'),
              createdAt: date(row, 'created_at'),
              updatedAt: date(row, 'updated_at'),
            },
          });
          stats.connections += 1;
        }

        for (const row of sqliteRows(db, 'SELECT * FROM oauth_clients')) {
          await tx.oauthClient.create({
            data: {
              server: str(row, 'server'),
              clientInformation: json(row, 'client_information'),
              createdAt: date(row, 'created_at'),
              updatedAt: date(row, 'updated_at'),
            },
          });
          stats.oauth_clients += 1;
        }
      }

      // event_consumers: everyone starts after the imported log
      for (const name of CONSUMER_NAMES) {
        await tx.eventConsumer.create({ data: { name, lastSeq: BigInt(maxSeq) } });
        stats.event_consumers += 1;
      }

      // threads projection — replayed from the imported log, same transaction
      projection = await rebuildThreadsProjection(tx);
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 30_000 },
  );

  console.log(`[import-sqlite] imported: ${JSON.stringify(stats)}`);
  console.log(`[import-sqlite] threads projection: ${projection.threads} threads, ${projection.terminals} terminals (source had ${source.threads})`);

  if (skippedCcr.length) {
    console.log(
      `[import-sqlite] skipped ccr_sessions of main threads: ${skippedCcr
        .map(row => `${str(row, 'thread_id')} (${str(row, 'cse_id')})`)
        .join(', ')} and ${source.ccr_deliveries - stats.ccr_deliveries} of their deliveries`,
    );
  }

  if (skipConnections) {
    console.log(`[import-sqlite] connections skipped (--skip-connections): ${source.connections} rows, ${source.oauth_clients} oauth clients`);
  }

  // verification (read-only, after the commit): counts, seq, sampled payloads
  const problems: string[] = [];
  const expect = (label: string, actual: number | bigint, expected: number) => {
    if (Number(actual) !== expected) {
      problems.push(`${label}: ${actual} != ${expected}`);
    }
  };

  expect('users', await prisma.user.count(), source.users);
  expect('events', await prisma.event.count(), source.events);
  expect('threads', await prisma.thread.count(), source.threads);
  expect('ccr_sessions', await prisma.ccrSession.count(), source.ccr_sessions - skippedCcr.length);
  expect('ccr_deliveries', await prisma.ccrDelivery.count(), stats.ccr_deliveries);
  expect('event_consumers', await prisma.eventConsumer.count(), CONSUMER_NAMES.length);
  expect('projects', await prisma.project.count(), source.projects);
  expect('scheduled_tasks', await prisma.scheduledTask.count(), source.scheduled_tasks);
  expect('files', await prisma.file.count(), source.files);

  if (!skipConnections) {
    expect('connections', await prisma.connection.count(), source.connections);
    expect('oauth_clients', await prisma.oauthClient.count(), source.oauth_clients);
  }

  const targetMax = await prisma.event.aggregate({ _max: { seq: true } });

  expect('max(seq)', targetMax._max.seq ?? 0n, maxSeq);

  const [sequence] = await prisma.$queryRaw<Array<{ last_value: bigint; is_called: boolean }>>`SELECT last_value, is_called FROM events_seq_seq`;

  expect('sequence last_value', sequence.last_value, maxSeq);

  if (!sequence.is_called) {
    problems.push('sequence is_called=false: the next seq would repeat max(seq)');
  }

  const statuses = await prisma.thread.groupBy({ by: ['status'], _count: { _all: true } });

  for (const sourceStatus of sqliteRows(db, 'SELECT status, count(*) AS c FROM threads GROUP BY status')) {
    const target = statuses.find(s => s.status === str(sourceStatus, 'status'));

    expect(`threads.status=${str(sourceStatus, 'status')}`, target?._count._all ?? 0, int(sourceStatus, 'c'));
  }

  const sampleSeqs = new Set<number>([1, maxSeq]);

  while (sampleSeqs.size < Math.min(25, maxSeq)) {
    sampleSeqs.add(1 + Math.floor(Math.random() * maxSeq));
  }

  for (const seq of sampleSeqs) {
    const sourceRow = db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as Row;
    const targetRow = await prisma.event.findUnique({ where: { seq: BigInt(seq) } });

    if (!targetRow) {
      problems.push(`event seq=${seq} missing in target`);
      continue;
    }

    const same =
      targetRow.id === str(sourceRow, 'id') &&
      targetRow.type === str(sourceRow, 'type') &&
      targetRow.threadId === optStr(sourceRow, 'thread_id') &&
      targetRow.createdAt.getTime() === date(sourceRow, 'created_at').getTime() &&
      canonical(targetRow.payload) === canonical(JSON.parse(str(sourceRow, 'payload')));

    if (!same) {
      problems.push(`event seq=${seq} differs between source and target`);
    }
  }

  if (problems.length) {
    console.error(`[import-sqlite] VERIFICATION FAILED:\n  ${problems.join('\n  ')}`);
    console.error('[import-sqlite] the import is committed; to redo it, empty the target (TRUNCATE every table except _prisma_migrations) and rerun');
    process.exitCode = 1;
  } else {
    console.log(`[import-sqlite] verified: counts match, seq continues at ${maxSeq + 1}, ${sampleSeqs.size} sampled events identical`);
  }
} finally {
  db.close();
  await prisma.$disconnect();
}
