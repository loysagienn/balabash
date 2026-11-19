// The first real vertices of the tree — `get_event` and the nodes `threads`
// and `projects` — called the way every caller reaches them: through a grant and the one
// path of a call (src/catalog), over the stand's database. What the texts
// and the signatures say is checked against the design catalog outside the
// repository; here is what the actions do: the forms of the values, the
// order and the paging of the lists, the border of the workspace and the
// refusals.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityError, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

const NO_CONNECTIONS: ConnectionsPort = {
  accounts: async () => [],
  secretsReady: async () => false,
};

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let ingestFile: typeof import('../files/index.ts')['ingestFile'];
let tree: typeof import('./index.ts');
let grant: Grant;
// A second workspace with a thread and an event of its own: what the caller
// must not reach.
let foreign: { workspaceId: string; threadId: string; seq: number; grant: Grant };

type Value = Record<string, any>;

async function grantOf(workspaceId: string, threadId: string): Promise<Grant> {
  return computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call'] },
    { caller: { workspaceId, threadId, agentName: 'tester' }, connections: NO_CONNECTIONS },
  );
}

function invoke(name: string, input: JsonObject, as: Grant = grant): Promise<Value> {
  return invokeCapability(as, name, input, { connections: NO_CONNECTIONS }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.match(error.message, message);

    return true;
  });
}

// Appends an event of the stand's workspace and gives its seq and id.
async function append(type: string, threadId: string, payload: JsonObject, extra: Partial<Parameters<typeof appendEvent>[0]> = {}) {
  const result = await appendEvent({ type, actor: 'system', workspaceId: stand.workspaceId, threadId, payload, ...extra });

  assert.ok(result.written, `${type} is written`);

  return { seq: Number(result.event.seq), id: result.event.id };
}

async function startChild(title: string, policy: JsonObject = {}, workspaceId = stand.workspaceId, parent = stand.mainThreadId): Promise<string> {
  const threadId = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', workspaceId, threadId, targetThreadId: parent, payload: { agent: 'engineer', title, ...policy } });

  return threadId;
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('../core/append.ts'));
  ({ ingestFile } = await import('../files/index.ts'));
  tree = await import('./index.ts');
  grant = await grantOf(stand.workspaceId, stand.mainThreadId);

  const { ensureMainThread } = await import('../core/threads.ts');
  const { id: workspaceId } = await prisma.workspace.create({ data: {} });
  const main = await ensureMainThread(workspaceId);
  const threadId = await startChild('Their work', {}, workspaceId, main.id);
  const result = await appendEvent({ type: 'thread.progress', actor: 'system', workspaceId, threadId, payload: { text: 'theirs' } });

  assert.ok(result.written);
  foreign = { workspaceId, threadId, seq: Number(result.event.seq), grant: await grantOf(workspaceId, main.id) };
});

after(() => stand.stop());

describe('the tree', () => {
  test('builds by the rules of the scheme, without warnings', async () => {
    const { buildCatalog } = await import('../catalog/index.ts');
    const { catalog, warnings } = buildCatalog(tree.root);

    assert.deepEqual(warnings, []);
    assert.deepEqual(
      [...catalog.vertices.keys()],
      [
        '',
        'export_file',
        'import_file',
        'get_file_url',
        'view_file',
        'get_event',
        'threads',
        'threads_list',
        'threads_get',
        'threads_get_transcript',
        'threads_get_events',
        'projects',
        'projects_list',
        'projects_get',
        'projects_create',
        'projects_update',
        'projects_archive',
        'projects_unarchive',
        'workspace',
        'workspace_query',
        'workspace_run_command',
        'workspace_files',
        'workspace_files_read',
        'workspace_files_write',
        'workspace_files_list',
        'workspace_files_stat',
        'workspace_files_delete',
        'workspace_apps',
        'workspace_apps_list',
        'workspace_apps_publish',
        'workspace_apps_unpublish',
      ],
    );
  });

  test('a recipe of the root is in its guide only together with the capability it names', () => {
    const names = new Set([...tree.catalog().vertices.keys(), ...tree.catalog().actions.keys()]);

    for (const recipe of tree.root.guide ?? []) {
      for (const required of recipe.requires ?? []) {
        assert.ok(names.has(required), `${required} is in the tree`);
      }
    }
  });
});

describe('get_event', () => {
  test('one event of the log in the form of the catalog, the payload verbatim', async () => {
    const threadId = await startChild('Reads an event');
    const payload = { text: 'half way', nested: { list: [1, 'two', null, { deep: true }] } };
    const { seq, id } = await append('thread.progress', threadId, payload, { actor: 'agent', agentName: 'engineer', targetThreadId: stand.mainThreadId });
    const event = await invoke('get_event', { seq });

    assert.deepEqual(Object.keys(event), ['seq', 'id', 'type', 'actor', 'agentName', 'threadId', 'targetThreadId', 'payload', 'createdAt']);
    assert.deepEqual(
      { ...event, createdAt: null },
      { seq, id, type: 'thread.progress', actor: 'agent', agentName: 'engineer', threadId, targetThreadId: stand.mainThreadId, payload, createdAt: null },
    );
    assert.equal(new Date(event.createdAt).toISOString(), event.createdAt);
  });

  test('a seq that names nothing, and an event of another workspace, are not found alike', async () => {
    await refuses(invoke('get_event', { seq: 999_999_999 }), 'not_found', /no event with seq 999999999/);
    await refuses(invoke('get_event', { seq: 0 }), 'not_found', /no event with seq 0/);
    await refuses(invoke('get_event', { seq: foreign.seq }), 'not_found', new RegExp(`no event with seq ${foreign.seq}`));
    assert.equal((await invoke('get_event', { seq: foreign.seq }, foreign.grant)).seq, foreign.seq);
  });

  test('a seq that is not an integer is refused before the action', async () => {
    await refuses(invoke('get_event', { seq: '12' }), 'invalid_input', /get_event\(input/);
    await refuses(invoke('get_event', { seq: 1.5 }), 'invalid_input', /seq/);
  });
});

describe('threads_list', () => {
  let ids: string[];

  before(async () => {
    ids = [];

    for (const title of ['List one', 'List two', 'List three', 'List four', 'List five']) {
      ids.push(await startChild(title, title === 'List two' ? { headless: true } : title === 'List three' ? { remote: true } : {}));
    }

    await append('thread.failed', ids[3] as string, { error: 'boom' });
    await append('thread.completed', ids[4] as string, { summary: { text: 'done' }, description: 'Listed five things.', title: 'List five, done' });
  });

  test('newest first, in the form of Thread, a page at a time until nextCursor is null', async () => {
    const seen: Value[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const result = await invoke('threads_list', { limit: 2, ...(cursor ? { cursor } : {}) });

      assert.ok(result.threads.length <= 2);
      seen.push(...result.threads);
      cursor = result.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    const total = await prisma.thread.count({ where: { workspaceId: stand.workspaceId } });

    assert.equal(seen.length, total, 'every thread of the workspace, each once');
    assert.equal(new Set(seen.map(thread => thread.threadId)).size, total);
    assert.equal(pages, Math.ceil(total / 2), 'no empty page at the end');
    assert.deepEqual(seen.slice(0, 5).map(thread => thread.threadId), [...ids].reverse(), 'the newest threads lead');
    assert.equal(seen[seen.length - 1]?.threadId, stand.mainThreadId, 'the main thread is the oldest');

    const [five, four, three, two] = seen;

    assert.deepEqual(Object.keys(five as Value), ['threadId', 'parentThreadId', 'agent', 'title', 'description', 'status', 'headless', 'remote', 'createdAt', 'updatedAt']);
    assert.deepEqual(
      { ...five, createdAt: null, updatedAt: null },
      { threadId: ids[4], parentThreadId: stand.mainThreadId, agent: 'engineer', title: 'List five, done', description: 'Listed five things.', status: 'completed', headless: false, remote: false, createdAt: null, updatedAt: null },
    );
    assert.equal(four?.status, 'failed');
    assert.equal(four?.description, null);
    assert.deepEqual([three?.remote, three?.headless, two?.remote, two?.headless], [true, false, false, true]);
    assert.equal(seen[seen.length - 1]?.parentThreadId, null);
  });

  test('a page that ends exactly at the last thread has no next one', async () => {
    const total = await prisma.thread.count({ where: { workspaceId: stand.workspaceId } });
    const result = await invoke('threads_list', { limit: total });

    assert.equal(result.threads.length, total);
    assert.equal(result.nextCursor, null);
  });

  test('filters by status and by the moment of the start; threads of another workspace never show', async () => {
    const failed = await invoke('threads_list', { status: 'failed' });

    assert.deepEqual(failed.threads.map((thread: Value) => thread.threadId), [ids[3]]);

    const all = (await invoke('threads_list', {})).threads as Value[];

    assert.ok(!all.some(thread => thread.threadId === foreign.threadId));

    const third = all.find(thread => thread.threadId === ids[2]) as Value;
    const since = await invoke('threads_list', { createdAtGte: third.createdAt });
    const until = await invoke('threads_list', { createdAtLte: third.createdAt });

    assert.ok(since.threads.every((thread: Value) => thread.createdAt >= third.createdAt));
    assert.ok(since.threads.some((thread: Value) => thread.threadId === ids[4]));
    assert.ok(until.threads.every((thread: Value) => thread.createdAt <= third.createdAt));
    assert.ok(until.threads.some((thread: Value) => thread.threadId === stand.mainThreadId));
    assert.deepEqual((await invoke('threads_list', { createdAtGte: '2999-01-01T00:00:00+03:00' })).threads, []);
  });

  test('a moment finer than a millisecond stays inside the range asked for', async () => {
    const all = (await invoke('threads_list', {})).threads as Value[];
    const third = all.find(thread => thread.threadId === ids[2]) as Value;
    // A moment after the start of the thread, by less than a millisecond.
    const justAfter = (third.createdAt as string).replace('Z', '0001Z');
    const shows = async (filter: JsonObject) => ((await invoke('threads_list', filter)).threads as Value[]).some(thread => thread.threadId === ids[2]);

    assert.equal(await shows({ createdAtGte: justAfter }), false, 'started before the moment');
    assert.equal(await shows({ createdAtLte: justAfter }), true);
    // The same moment written with more digits is the same moment.
    assert.equal(await shows({ createdAtGte: (third.createdAt as string).replace('Z', '000Z') }), true);
  });

  test('a moment without an offset, a made-up cursor and a limit out of range are invalid input', async () => {
    await refuses(invoke('threads_list', { createdAtGte: '2026-01-31T09:00:00' }), 'invalid_input', /createdAtGte is not an ISO 8601 date-time with an offset/);
    await refuses(invoke('threads_list', { createdAtLte: 'yesterday' }), 'invalid_input', /createdAtLte is not an ISO 8601 date-time/);
    for (const cursor of ['next', '0', '00042', '-1', '9223372036854775808']) {
      await refuses(invoke('threads_list', { cursor }), 'invalid_input', /cursor is not a cursor of this list/);
    }

    // The largest position the log can hold is a cursor like any other.
    assert.ok((await invoke('threads_list', { cursor: '9223372036854775807', limit: 1 })).threads.length === 1);
    await refuses(invoke('threads_list', { limit: 1001 }), 'invalid_input', /limit/);
    await refuses(invoke('threads_list', { status: null }), 'invalid_input', /status/);
  });
});

describe('threads_get', () => {
  test('an active thread, and one ended from outside, have no summary', async () => {
    const active = await startChild('Still running');
    const cancelled = await startChild('Stopped');

    await append('thread.cancelled', cancelled, { reason: 'stop' });

    const first = await invoke('threads_get', { threadId: active });

    assert.equal(first.thread.threadId, active);
    assert.equal(first.thread.status, 'active');
    assert.equal(first.summary, null);
    assert.equal((await invoke('threads_get', { threadId: cancelled })).summary, null);
  });

  test('the summary gives references of its files and seqs of the events it refers to', async () => {
    const threadId = await startChild('Reports');
    const shot = await ingestFile({ body: Buffer.from('<png>'), contentType: 'image/png', sizeBytes: 5, originalFilename: 'shot.png', width: 32, height: 16, workspaceId: stand.workspaceId });
    const theirs = await ingestFile({ body: Buffer.from('theirs'), contentType: 'text/plain', sizeBytes: 6, originalFilename: 'theirs.txt', workspaceId: foreign.workspaceId });
    const first = await append('thread.progress', threadId, { text: 'step one' });
    const second = await append('thread.progress', threadId, { text: 'step two' });
    const theirEvent = await prisma.event.findUniqueOrThrow({ where: { seq: BigInt(foreign.seq) } });

    await append('thread.completed', threadId, {
      summary: { text: 'All done.', fileIds: [shot.id, randomUUID(), theirs.id], refs: [second.id, randomUUID(), theirEvent.id, first.id] },
      description: 'Reported.',
    });

    const { thread, summary } = await invoke('threads_get', { threadId });

    assert.equal(thread.status, 'completed');
    assert.equal(thread.description, 'Reported.');
    assert.deepEqual(summary, {
      text: 'All done.',
      // A file that is not in the workspace (never was, or belongs to another one) is left out.
      files: [{ kind: 'file', id: shot.id, name: 'shot.png', contentType: 'image/png', sizeBytes: 5, width: 32, height: 16 }],
      // In the order of the summary; an id that names no event of the workspace is left out.
      refs: [second.seq, first.seq],
    });
  });

  test('a summary without files and references gives empty lists, never a missing key', async () => {
    const threadId = await startChild('Short report');

    await append('thread.completed', threadId, { summary: { text: 'Done.' } });

    assert.deepEqual((await invoke('threads_get', { threadId })).summary, { text: 'Done.', files: [], refs: [] });
  });

  test('a thread that does not exist, and a thread of another workspace, are not found alike', async () => {
    const missing = randomUUID();

    await refuses(invoke('threads_get', { threadId: missing }), 'not_found', new RegExp(`no thread "${missing}"`));
    await refuses(invoke('threads_get', { threadId: foreign.threadId }), 'not_found', /no thread/);
    assert.equal((await invoke('threads_get', { threadId: foreign.threadId }, foreign.grant)).thread.threadId, foreign.threadId);
  });
});

describe('threads_get_events', () => {
  let threadId: string;
  let seqs: number[];

  before(async () => {
    threadId = await startChild('Has events');
    seqs = [];

    for (const step of [1, 2, 3]) {
      seqs.push((await append('thread.progress', threadId, { text: `step ${step}` })).seq);
    }

    // Addressed to the thread by its parent, and the thread's own session journal.
    seqs.push((await append('thread.message', stand.mainThreadId, { text: 'go on' }, { targetThreadId: threadId })).seq);
    seqs.push((await append('session.message', threadId, { text: 'inner' })).seq);
  });

  test('the events the thread authored and the events addressed to it, whole, newest first', async () => {
    const { events, nextCursor } = await invoke('threads_get_events', { threadId });

    assert.equal(nextCursor, null);
    assert.deepEqual(events.map((event: Value) => event.seq), [...seqs].reverse().concat(events[events.length - 1].seq));
    assert.equal(events[events.length - 1].type, 'thread.started');
    assert.deepEqual(events[0].payload, { text: 'inner' });
    assert.equal(events[1].threadId, stand.mainThreadId);
    assert.equal(events[1].targetThreadId, threadId);
    assert.deepEqual(await invoke('get_event', { seq: events[2].seq }), events[2], 'the same form as get_event');
  });

  test('pages go from the newest events to older ones, and the type filter applies before paging', async () => {
    const first = await invoke('threads_get_events', { threadId, limit: 4 });

    assert.deepEqual(first.events.map((event: Value) => event.seq), [...seqs].reverse().slice(0, 4));
    assert.equal(typeof first.nextCursor, 'string');

    const second = await invoke('threads_get_events', { threadId, limit: 4, cursor: first.nextCursor });

    assert.deepEqual(second.events.map((event: Value) => event.type), ['thread.progress', 'thread.started']);
    assert.equal(second.nextCursor, null);

    const progress = await invoke('threads_get_events', { threadId, types: ['thread.progress'], limit: 2 });

    assert.deepEqual(progress.events.map((event: Value) => event.seq), [seqs[2], seqs[1]]);

    const rest = await invoke('threads_get_events', { threadId, types: ['thread.progress'], limit: 2, cursor: progress.nextCursor });

    assert.deepEqual(rest.events.map((event: Value) => event.seq), [seqs[0]]);
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(await invoke('threads_get_events', { threadId, types: ['thread.message', 'no.such.type'] }).then(result => result.events.map((event: Value) => event.seq)), [seqs[3]]);
    assert.deepEqual((await invoke('threads_get_events', { threadId, types: [] })).events, []);
  });

  test('a thread of another workspace is not found; a made-up cursor is invalid input', async () => {
    await refuses(invoke('threads_get_events', { threadId: foreign.threadId }), 'not_found', /no thread/);
    await refuses(invoke('threads_get_events', { threadId, cursor: '-1' }), 'invalid_input', /cursor/);
  });
});

describe('threads_get_transcript', () => {
  // A transcript is a line per event.
  const eventLines = (transcript: string) =>
    transcript
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Value);
  const PAGE_LIMIT = 50_000;

  // Every page of the thread, read to the end: the lines in the order of
  // the log, and the size of the largest page.
  async function readAll(threadId: string, limit = 400): Promise<{ lines: Value[]; pages: number; largest: number }> {
    const lines: Value[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let largest = 0;

    do {
      const result = await invoke('threads_get_transcript', { threadId, limit, ...(cursor ? { cursor } : {}) });
      const page = eventLines(result.transcript);

      assert.ok(page.length > 0, 'a page with a next one shows events');
      lines.unshift(...page);
      largest = Math.max(largest, result.transcript.length);
      cursor = result.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    return { lines, pages, largest };
  }

  test('a page reads in chronological order, each event with its seq, the session journal aside', async () => {
    const threadId = await startChild('Has a course');
    const seqs: number[] = [];

    for (const step of [1, 2, 3, 4]) {
      seqs.push((await append('thread.progress', threadId, { text: `step ${step}` })).seq);
    }

    await append('session.message', threadId, { text: 'inner' });

    const first = await invoke('threads_get_transcript', { threadId, limit: 3 });

    assert.deepEqual(eventLines(first.transcript).map(line => [line.seq, line.payload.text]), [[seqs[1], 'step 2'], [seqs[2], 'step 3'], [seqs[3], 'step 4']]);
    assert.ok(!first.transcript.includes('inner'));

    const second = await invoke('threads_get_transcript', { threadId, limit: 3, cursor: first.nextCursor });

    assert.deepEqual(eventLines(second.transcript).map(line => line.type), ['thread.started', 'thread.progress']);
    assert.equal(eventLines(second.transcript)[1]?.seq, seqs[0]);
    assert.equal(second.nextCursor, null);

    const whole = await invoke('threads_get_transcript', { threadId });

    assert.equal(eventLines(whole.transcript).length, 5);
    assert.equal(whole.nextCursor, null);
  });

  test('a page may hold fewer events than the limit: what did not fit its size is the next page', async () => {
    const threadId = await startChild('Has a long course');
    const seqs: number[] = [];

    // 30 events of about 5000 characters each: more than one page of text takes.
    for (let step = 0; step < 30; step += 1) {
      seqs.push((await append('thread.progress', threadId, { text: `${step}:${'x'.repeat(5000)}` })).seq);
    }

    const { lines, pages, largest } = await readAll(threadId);

    assert.ok(pages > 1, 'the page is cut by its size');
    assert.ok(largest <= PAGE_LIMIT);
    assert.deepEqual(lines.slice(1).map(line => line.seq), seqs, 'every event once, none lost between pages');
    assert.ok(lines.slice(1).every(line => line.truncated === true && line.payload.text.length < 5000), 'a long text is cut and marked');
  });

  test('no page outgrows its size: a payload of many short values is cut to its first items, then to its size alone', async () => {
    const threadId = await startChild('Has large events');
    const rows = Array.from({ length: 20_000 }, (_item, index) => `row ${index}`);
    const list = await append('tool.call.completed', threadId, { functionName: 'workspace_query', result: { structuredContent: { rows } } });
    const wide = await append('tool.call.completed', threadId, {
      functionName: 'workspace_query',
      result: { structuredContent: Object.fromEntries(rows.slice(0, 5_000).map((row, index) => [`key${index}`, row])) },
    });
    const seqs: number[] = [list.seq, wide.seq];

    // The ten newest events are long too: nothing is exempt from the size.
    for (let step = 0; step < 10; step += 1) {
      seqs.push((await append('thread.progress', threadId, { text: `${step}:${'x'.repeat(8000)}` })).seq);
    }

    const { lines, largest } = await readAll(threadId);

    assert.ok(largest <= PAGE_LIMIT, `the largest page is ${largest} characters`);
    assert.deepEqual(lines.slice(1).map(line => line.seq), seqs, 'every event once, in the order of the log');

    const [, listLine, wideLine] = lines as [Value, Value, Value];

    assert.equal(listLine.truncated, true);
    assert.deepEqual(listLine.payload.result.structuredContent.rows.slice(0, 2), ['row 0', 'row 1']);
    assert.match(listLine.payload.result.structuredContent.rows.at(-1), /^… \d+ more$/);
    assert.equal(listLine.payload.functionName, 'workspace_query');
    // No measure fits five thousand keys: the line keeps the event and the
    // size of what `get_event` gives by its seq.
    assert.deepEqual([wideLine.truncated, 'payload' in wideLine, wideLine.type], [true, false, 'tool.call.completed']);
    assert.ok(wideLine.payloadChars > 50_000);
    assert.equal(JSON.stringify((await invoke('get_event', { seq: wide.seq })).payload).length, wideLine.payloadChars);
  });

  test('every line names its author, whoever reads: a message of the secretary in a child thread', async () => {
    const threadId = await startChild('Talks to its parent');
    const author = { actor: 'agent' as const };
    const asked = await append('thread.message', stand.mainThreadId, { text: 'Do this.' }, { ...author, agentName: 'coordinator', targetThreadId: threadId });
    const answered = await append('thread.message', threadId, { text: 'Done.' }, { ...author, agentName: 'engineer', targetThreadId: stand.mainThreadId });
    const [started, question, answer] = eventLines((await invoke('threads_get_transcript', { threadId })).transcript) as [Value, Value, Value];

    // The thread's own events carry no threadId; an event from another
    // thread carries the id of that thread, and nothing says "addressed
    // here".
    assert.deepEqual(Object.keys(started), ['seq', 'type', 'actor', 'targetThreadId', 'createdAt', 'payload']);
    assert.deepEqual(
      { ...question, createdAt: null },
      { seq: asked.seq, type: 'thread.message', actor: 'agent', agentName: 'coordinator', threadId: stand.mainThreadId, createdAt: null, payload: { text: 'Do this.' } },
    );
    assert.deepEqual(
      { ...answer, createdAt: null },
      { seq: answered.seq, type: 'thread.message', actor: 'agent', agentName: 'engineer', targetThreadId: stand.mainThreadId, createdAt: null, payload: { text: 'Done.' } },
    );
    assert.equal(question.createdAt, (await invoke('get_event', { seq: asked.seq })).createdAt);
  });

  test('a thread without a course of its own gives its start; another workspace is not found', async () => {
    const threadId = await startChild('Just started');
    const result = await invoke('threads_get_transcript', { threadId });

    assert.deepEqual(eventLines(result.transcript).map(line => line.type), ['thread.started']);
    assert.equal(result.nextCursor, null);
    await refuses(invoke('threads_get_transcript', { threadId: foreign.threadId }), 'not_found', /no thread/);
    await refuses(invoke('threads_get_transcript', { threadId, limit: 401 }), 'invalid_input', /limit/);
  });
});

describe('projects', () => {
  let filesDir: string;
  const input = (slug: string, title = `Title of ${slug}`) => ({ title, slug, description: `What ${slug} is.` });

  before(async () => {
    const { workspaceFilesDir } = await import('../workspace/layout.ts');

    filesDir = workspaceFilesDir(stand.workspaceId);
  });

  test('create: the record in the form of Project, its folder with AGENTS.md, the event authored by the calling thread', async () => {
    const { project, adopted } = await invoke('projects_create', input('garden', '  Garden  '));

    assert.equal(adopted, false);
    assert.deepEqual(Object.keys(project), ['id', 'title', 'slug', 'description', 'archived', 'folder', 'createdAt', 'updatedAt']);
    assert.deepEqual(
      { ...project, id: null, createdAt: null, updatedAt: null },
      { id: null, title: 'Garden', slug: 'garden', description: 'What garden is.', archived: false, folder: 'garden', createdAt: null, updatedAt: null },
    );
    assert.match(await fs.readFile(path.join(filesDir, project.folder, 'AGENTS.md'), 'utf8'), /^# Garden/);

    const event = await prisma.event.findFirstOrThrow({ where: { type: 'project.created', workspaceId: stand.workspaceId }, orderBy: { seq: 'desc' } });

    assert.equal(event.threadId, stand.mainThreadId);
    assert.equal(event.actor, 'agent');
    assert.deepEqual(await invoke('projects_get', { project: 'garden' }), project);
  });

  test('create: an existing folder is adopted with its contents untouched', async () => {
    await fs.mkdir(path.join(filesDir, 'attic'), { recursive: true });
    await fs.writeFile(path.join(filesDir, 'attic', 'AGENTS.md'), 'mine');

    const { adopted } = await invoke('projects_create', input('attic'));

    assert.equal(adopted, true);
    assert.equal(await fs.readFile(path.join(filesDir, 'attic', 'AGENTS.md'), 'utf8'), 'mine');
  });

  test('create: a taken title, a taken slug and a file in the way are conflicts; a bad slug and a blank title are invalid input', async () => {
    await invoke('projects_create', input('cellar'));
    await fs.writeFile(path.join(filesDir, 'a-file'), 'not a folder');

    await refuses(invoke('projects_create', input('cellar', 'Another title')), 'conflict', /^The slug "cellar" is taken by the project "cellar"\. Pick another slug\.$/);
    await refuses(invoke('projects_create', input('cellar-two', 'Title of cellar')), 'conflict', /^The title "Title of cellar" is taken by the project "cellar"\. Pick another title\.$/);
    await refuses(invoke('projects_create', input('a-file')), 'conflict', /taken by a file/);
    await refuses(invoke('projects_create', input('Bad Slug')), 'invalid_input', /projects_create\(input/);
    await refuses(invoke('projects_create', input('blank-title', '   ')), 'invalid_input', /non-empty title/);
    assert.equal(await prisma.project.count({ where: { workspaceId: stand.workspaceId, slug: { in: ['cellar-two', 'a-file', 'blank-title'] } } }), 0);
  });

  test('get: by the slug; an unknown slug and a project of another workspace are not found alike', async () => {
    await invoke('projects_create', input('theirs'), foreign.grant);

    assert.equal((await invoke('projects_get', { project: 'theirs' }, foreign.grant)).slug, 'theirs');
    await refuses(invoke('projects_get', { project: 'theirs' }), 'not_found', /no project with the slug "theirs"/);
    await refuses(invoke('projects_get', { project: 'nowhere' }), 'not_found', /no project with the slug "nowhere"/);
  });

  test('update: a new title; a new slug renames the folder and the address; the fields are needed and not blank', async () => {
    await invoke('projects_create', input('shed'));

    const retitled = await invoke('projects_update', { project: 'shed', title: 'The shed' });

    assert.equal(retitled.project.title, 'The shed');
    assert.equal(retitled.project.description, 'What shed is.');
    assert.equal(retitled.renamedFrom, null);

    const moved = await invoke('projects_update', { project: 'shed', slug: 'workshop', description: 'What the workshop is.' });

    assert.deepEqual([moved.project.slug, moved.project.folder, moved.project.description, moved.renamedFrom], ['workshop', 'workshop', 'What the workshop is.', 'shed']);
    assert.equal(moved.project.id, retitled.project.id);
    assert.match(await fs.readFile(path.join(filesDir, 'workshop', 'AGENTS.md'), 'utf8'), /^# Title of shed/);
    await assert.rejects(fs.stat(path.join(filesDir, 'shed')));
    await refuses(invoke('projects_get', { project: 'shed' }), 'not_found', /no project/);

    await refuses(invoke('projects_update', { project: 'workshop' }), 'invalid_input', /at least one of: title, description, slug/);
    await refuses(invoke('projects_update', { project: 'workshop', title: '  ' }), 'invalid_input', /title is blank/);
    await refuses(invoke('projects_update', { project: 'nowhere', title: 'New' }), 'not_found', /no project/);
    await refuses(invoke('projects_update', { project: 'workshop', title: 'Garden' }), 'conflict', /The title "Garden" is taken by the project "garden"/);
    await refuses(invoke('projects_update', { project: 'workshop', slug: 'garden' }), 'conflict', /The slug "garden" is taken by the project "garden"/);
    await refuses(invoke('projects_update', { project: 'workshop', slug: 'a-file' }), 'conflict', /already taken/);
    assert.equal((await invoke('projects_get', { project: 'workshop' })).title, 'The shed');
  });

  test('archive and unarchive flip the flag once and say whether they did; the list puts live projects first', async () => {
    await invoke('projects_create', input('old-work'));
    await invoke('projects_create', input('new-work'));

    const archived = await invoke('projects_archive', { project: 'old-work' });

    assert.deepEqual([archived.project.archived, archived.changed], [true, true]);
    assert.deepEqual([(await invoke('projects_archive', { project: 'old-work' })).changed], [false]);
    assert.match(await fs.readFile(path.join(filesDir, 'old-work', 'AGENTS.md'), 'utf8'), /^# Title of old-work/);
    // An archived project keeps its title, and the refusal names it by the
    // address it reads by.
    await refuses(
      invoke('projects_create', input('old-work-again', 'Title of old-work')),
      'conflict',
      /taken by the project "old-work", which is archived: an archived project keeps its title\. Pick another title\./,
    );

    // A change of the record moves the project to the top of the live list.
    await invoke('projects_update', { project: 'garden', description: 'What the garden is now.' });

    const { projects } = await invoke('projects_list', {});
    const slugs = projects.map((project: Value) => project.slug);

    assert.equal(slugs[0], 'garden');
    assert.equal(slugs[1], 'new-work');
    assert.equal(slugs[slugs.length - 1], 'old-work');
    assert.ok(!slugs.includes('theirs'));
    assert.deepEqual(projects.map((project: Value) => project.archived), slugs.map((slug: string) => slug === 'old-work'));

    const back = await invoke('projects_unarchive', { project: 'old-work' });

    assert.deepEqual([back.project.archived, back.changed], [false, true]);
    assert.equal((await invoke('projects_unarchive', { project: 'old-work' })).changed, false);
    await refuses(invoke('projects_archive', { project: 'nowhere' }), 'not_found', /no project/);
  });
});
