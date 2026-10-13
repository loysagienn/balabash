// The remote engine over the stand (src/test-support/stand.ts) with a fake
// driver in memory: a thread opens a session (the row, session.started,
// our opening prompt's id for the echo); a read is mirrored atomically with
// the cursor; the owner's message reaches the driver as say with our id, a
// reply mirrored from the other side never goes back; an ask opens act and
// a decision resolves it through the driver; a long idle pauses the thread
// and a message wakes it; a failing watch backs off and tells the owner
// once after two hours; a gone session fails the thread; a second thread
// for one session is refused; a terminal closes the row without touching
// the session.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { Event, JsonObject, RemoteDriver, RemoteDriverContext, RemoteRead } from '../core/contract.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let getThread: typeof import('../core/threads.ts')['getThread'];
let engine: typeof import('./engine.ts');
let store: typeof import('./store.ts');

// The clock the engine reads — the tests move it.
let clock = new Date('2026-10-13T12:00:00Z');

const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

// The fake external system: sessions by ref, the reads queued per session,
// the verbs recorded.
type Session = { reads: RemoteRead[]; said: { text: string; messageId: string; files?: string[] }[]; answered: { askId: string; decision: string }[]; stopped: number; readCursors: unknown[]; files: Record<string, string> };

const sessions = new Map<string, Session>();
let opens = 0;
let readFailure: string | null = null;

function session(ref: string): Session {
  let found = sessions.get(ref);

  if (!found) {
    found = { reads: [], said: [], answered: [], stopped: 0, readCursors: [], files: {} };
    sessions.set(ref, found);
  }

  return found;
}

const driver: RemoteDriver = {
  open: async (_ctx, input) => {
    opens += 1;

    const ref = `sess-${opens}`;

    session(ref).said.push({ text: input.prompt, messageId: input.messageId });

    return { ref, link: `https://ext/${ref}` };
  },
  describe: async (_ctx, ref) => ({ exists: sessions.has(ref), link: `https://ext/${ref}` }),
  read: async (_ctx, { ref, cursor }) => {
    if (readFailure) {
      throw new Error(readFailure);
    }

    const current = session(ref);

    current.readCursors.push(cursor);

    return current.reads.shift() ?? { cursor: cursor ?? 'c0', phase: 'idle', items: [] };
  },
  say: async (_ctx, { ref, text, messageId, files }) => {
    session(ref).said.push({ text, messageId, ...(files.length ? { files: files.map(file => file.originalFilename ?? file.id) } : {}) });
  },
  fetchFile: async (_ctx, { ref, path }) => {
    const body = session(ref).files[path];

    return body === undefined ? null : { body, filename: path.split('/').pop()!, contentType: 'text/plain' };
  },
  answer: async (_ctx, { ref, askId, decision }) => {
    session(ref).answered.push({ askId, decision });
  },
  stop: async (_ctx, ref) => {
    session(ref).stopped += 1;
  },
};

// The files surface of the driver: the stand's own storage.
const context: RemoteDriverContext = { secrets: { get: async () => 'token' }, files: {} as RemoteDriverContext['files'] };
let ingestFile: typeof import('../files/index.ts')['ingestFile'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('../core/append.ts'));
  ({ getThread } = await import('../core/threads.ts'));
  engine = await import('./engine.ts');
  store = await import('./store.ts');

  const files = await import('../files/index.ts');

  ingestFile = files.ingestFile;
  context.files = {
    ingest: input => files.ingestFile(input),
    get: fileId => files.getFile(fileId),
    open: fileId => files.openFileContent(fileId),
  };

  engine.configureRemoteEngine({
    // The kind's default policy lets urgent words through (a thread's
    // policy clamps notifications; the platform default is normal).
    resolveKind: kind => (kind === 'fake_agent' ? { driver, context, notification: 'urgent' } : null),
    now: () => clock,
    readTimeoutMs: 2_000,
  });
});

after(() => stand.stop());

// A remote child started the way a spawn starts it; the engine opens it as
// the router's spawn hook would.
async function openThread(payload: JsonObject, parentThreadId = stand.mainThreadId): Promise<{ threadId: string; started: Event; ref: string }> {
  const threadId = randomUUID();
  const result = await appendEvent({
    type: 'thread.started',
    actor: 'system',
    userId: stand.userId,
    threadId,
    targetThreadId: parentThreadId,
    payload: { agent: 'fake_agent', title: 'Remote', remote: true, ...payload },
  });

  assert.ok(result.written);

  const thread = (await getThread(threadId))!;
  const run = await engine.openRemoteThread(thread, result.event);

  assert.ok(run, 'the thread opened');

  const row = await store.getRow(threadId);

  return { threadId, started: result.event, ref: row!.ref };
}

async function eventsOf(threadId: string, types?: string[]): Promise<Event[]> {
  const rows = await prisma.event.findMany({ where: { threadId, ...(types ? { type: { in: types } } : {}) }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ ...row, payload: row.payload as JsonObject }) as unknown as Event);
}

async function pass(): Promise<void> {
  await engine.runRemotePass();
  await engine.settled();
}

describe('the remote engine', () => {
  test('opens a session: the row, session.started and the run state, the opening prompt under our id', async () => {
    const { threadId, started, ref } = await openThread({ input: 'do x', options: { harness: 'pi', model: 'big' } });
    const row = (await store.getRow(threadId))!;

    assert.equal(row.kind, 'fake_agent');
    assert.equal(row.link, `https://ext/${ref}`);
    assert.equal(row.phase, 'working');
    assert.deepEqual(row.watch.ownMessageIds, [started.id]);
    assert.deepEqual(session(ref).said, [{ text: 'do x', messageId: started.id }]);
    assert.deepEqual(
      (await eventsOf(threadId, ['session.started', 'session.state'])).map(event => [event.type, event.payload]),
      [
        ['session.started', { model: 'big', effort: null, tools: [], mcpServers: [] }],
        ['session.state', { state: 'run' }],
      ],
    );
  });

  test('a read is mirrored with the cursor; the echo of our prompt is skipped; the state follows the phase', async () => {
    const { threadId, started, ref } = await openThread({ input: 'do y' });

    session(ref).reads.push({
      cursor: 'c1',
      phase: 'idle',
      items: [
        { kind: 'turn.started', turnId: 'turn-1', messageId: started.id },
        { kind: 'prompt', messageId: started.id, text: 'do y' },
        { kind: 'tool.started', turnId: 'turn-1', callId: 'call-1', name: 'bash', input: { cmd: 'ls' } },
        { kind: 'tool.finished', turnId: 'turn-1', callId: 'call-1', name: 'bash', output: 'ok' },
        { kind: 'text', turnId: 'turn-1', text: 'y is done' },
        { kind: 'turn.finished', turnId: 'turn-1', outcome: 'completed', text: 'y is done' },
      ],
    });

    await pass();

    const row = (await store.getRow(threadId))!;

    assert.equal(row.cursor, 'c1');
    assert.equal(row.phase, 'idle');
    assert.deepEqual(session(ref).readCursors, [null]);
    assert.deepEqual(
      (await eventsOf(threadId)).map(event => event.type),
      ['thread.started', 'session.started', 'session.state', 'tool.call.started', 'tool.call.completed', 'agent.message', 'session.state'],
    );
    assert.deepEqual((await eventsOf(threadId, ['session.state'])).map(event => event.payload.state), ['run', 'wait']);
    assert.deepEqual(await eventsOf(threadId, ['user.message']), []);
    assert.ok(row.nextPollAt.getTime() > clock.getTime(), 'the next read is scheduled');

    // Not due yet: the next pass leaves it; due after the idle interval.
    await pass();
    assert.equal(session(ref).readCursors.length, 1);
    tick(engine.READ_EVERY_MS.idle);
    await pass();
    assert.deepEqual(session(ref).readCursors, [null, 'c1']);
  });

  test('the events of a read and the cursor commit together or not at all', async () => {
    const { threadId } = await openThread({ input: 'atomic' });
    const row = (await store.getRow(threadId))!;

    await assert.rejects(
      store.advanceRow(threadId, { cursor: 'c-lost' }, [
        { type: 'agent.message', actor: 'agent', agentName: 'fake_agent', userId: stand.userId, threadId, payload: { content: [{ type: 'text', text: 'first' }] } },
        // Invalid: thread.message needs a non-empty text.
        { type: 'thread.message', actor: 'agent', agentName: 'fake_agent', userId: stand.userId, threadId, targetThreadId: stand.mainThreadId, payload: { text: '' } },
      ]),
    );
    assert.equal((await store.getRow(threadId))!.cursor, row.cursor);
    assert.deepEqual(await eventsOf(threadId, ['agent.message']), []);
  });

  test('the owner’s message reaches the session under our id and wakes the read; a mirrored foreign reply never goes back', async () => {
    const { threadId, ref } = await openThread({ input: 'talk' });

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [{ kind: 'turn.finished', turnId: 't', outcome: 'completed', text: '' }] });
    await pass();
    assert.equal((await store.getRow(threadId))!.phase, 'idle');

    const message = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'and z', source: 'web', files: [{ fileId: 'f1', originalFilename: 'notes.md' }] } });

    assert.ok(message.written);
    engine.inbound(threadId, message.event);
    await engine.settled();

    const row = (await store.getRow(threadId))!;

    // The attachment names a file that is not stored: dropped, the text goes.
    assert.deepEqual(session(ref).said.at(-1), { text: 'and z', messageId: message.event.id });
    assert.equal(row.phase, 'working');
    assert.ok(row.watch.ownMessageIds.includes(message.event.id));
    assert.deepEqual((await eventsOf(threadId, ['session.state'])).map(event => event.payload.state), ['run', 'wait', 'run']);

    const foreign = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'from context', source: 'remote', identity: { username: 'alice' } } });

    assert.ok(foreign.written);
    engine.inbound(threadId, foreign.event);
    await engine.settled();
    assert.equal(session(ref).said.length, 2);

    // The parent's thread.message is the owner's voice too.
    const fromParent = await appendEvent({ type: 'thread.message', actor: 'agent', agentName: 'coordinator', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: { text: 'parent says' } });

    assert.ok(fromParent.written);
    engine.inbound(threadId, fromParent.event);
    await engine.settled();
    assert.equal(session(ref).said.at(-1)?.text, 'parent says');
  });

  test('an ask opens act with an urgent word; a decision answers through the driver and resolves it once', async () => {
    const { threadId, ref } = await openThread({ input: 'ask me' });

    session(ref).reads.push({
      cursor: 'c1',
      phase: 'asking',
      items: [{ kind: 'ask.opened', askId: 'ask-1', askKind: 'approval', text: 'POST /api/issues', link: 'https://ext/chat', options: ['allow', 'deny'] }],
    });
    await pass();

    assert.equal((await store.getRow(threadId))!.phase, 'asking');
    assert.deepEqual(
      (await eventsOf(threadId, ['agent.ask', 'thread.notification', 'session.state'])).map(event => [event.type, event.payload]),
      [
        ['session.state', { state: 'run' }],
        ['agent.ask', { askId: 'ask-1', kind: 'approval', text: 'POST /api/issues', link: 'https://ext/chat', options: ['allow', 'deny'] }],
        ['thread.notification', { level: 'urgent', text: 'Needs your decision: POST /api/issues — https://ext/chat' }],
        ['session.state', { state: 'act' }],
      ],
    );

    const decide = await appendEvent({ type: 'thread.decide', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: { askId: 'ask-1', decision: 'allow', identity: { username: 'operator' }, source: 'web' } });

    assert.ok(decide.written);
    engine.inbound(threadId, decide.event);
    await engine.settled();

    assert.deepEqual(session(ref).answered, [{ askId: 'ask-1', decision: 'allow' }]);
    assert.deepEqual((await eventsOf(threadId, ['agent.ask.resolved'])).map(event => event.payload), [{ askId: 'ask-1', outcome: 'allow', by: { identity: { username: 'operator' }, source: 'web' } }]);
    assert.equal((await store.getRow(threadId))!.phase, 'working');

    // The driver reports the same ask closed: nothing new is written.
    session(ref).reads.push({ cursor: 'c2', phase: 'working', items: [{ kind: 'ask.closed', askId: 'ask-1', outcome: 'approved_once' }] });
    tick(engine.READ_EVERY_MS.working);
    await pass();
    assert.equal((await eventsOf(threadId, ['agent.ask.resolved'])).length, 1);
    assert.deepEqual((await store.getRow(threadId))!.watch.resolvedAsks, []);
  });

  test('idle for half an hour pauses the thread, read rarely; a message wakes it', async () => {
    const { threadId, ref } = await openThread({ input: 'sleepy' });

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [{ kind: 'turn.finished', turnId: 't', outcome: 'completed', text: '' }] });
    await pass();
    tick(engine.PAUSE_AFTER_MS);
    await pass();

    const paused = (await store.getRow(threadId))!;

    assert.equal(paused.phase, 'paused');
    assert.equal(paused.nextPollAt.getTime() - clock.getTime(), engine.READ_EVERY_MS.paused);
    assert.deepEqual((await eventsOf(threadId, ['session.state'])).map(event => event.payload.state), ['run', 'wait', 'paused']);

    const message = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'wake up' } });

    assert.ok(message.written);
    engine.inbound(threadId, message.event);
    await engine.settled();
    assert.equal((await store.getRow(threadId))!.phase, 'working');
    assert.equal((await eventsOf(threadId, ['session.state'])).at(-1)?.payload.state, 'run');
  });

  test('activity on the other side wakes a paused thread', async () => {
    const { threadId, ref } = await openThread({ input: 'quiet' });

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [] });
    await pass();
    tick(engine.PAUSE_AFTER_MS);
    await pass();
    assert.equal((await store.getRow(threadId))!.phase, 'paused');

    session(ref).reads.push({ cursor: 'c2', phase: 'working', items: [{ kind: 'prompt', messageId: 'foreign', author: 'bob', text: 'go on' }] });
    tick(engine.READ_EVERY_MS.paused);
    await pass();
    assert.equal((await store.getRow(threadId))!.phase, 'working');
    assert.deepEqual((await eventsOf(threadId, ['user.message'])).map(event => event.payload), [{ text: 'go on', source: 'remote', identity: { username: 'bob' } }]);
  });

  test('a failing watch backs off and tells the owner after two hours, then every quarter hour; the thread’s state stays', async () => {
    const { threadId } = await openThread({ input: 'flaky' });

    readFailure = 'HTTP 503';

    try {
      await pass();

      let row = (await store.getRow(threadId))!;

      assert.equal(row.pollFailures, 1);
      assert.equal(row.phase, 'working');
      assert.equal(row.nextPollAt.getTime() - clock.getTime(), engine.BACKOFF_BASE_MS);

      for (let i = 0; i < 12; i += 1) {
        tick(engine.BACKOFF_MAX_MS);
        await pass();
      }

      row = (await store.getRow(threadId))!;
      assert.equal(row.nextPollAt.getTime() - clock.getTime(), engine.BACKOFF_MAX_MS);

      // Told at the two-hour mark, urgently; then every fifteen minutes of
      // failing, in the normal tone: 120, 135, 150, 165,
      // 180 minutes in.
      const warnings = await eventsOf(threadId, ['thread.notification']);

      assert.deepEqual(
        warnings.map(event => event.payload.level),
        ['urgent', 'normal', 'normal', 'normal', 'normal'],
      );
      assert.equal(warnings[0].payload.text, 'The session cannot be watched: HTTP 503');
      assert.deepEqual(await eventsOf(threadId, ['thread.failed']), []);
    } finally {
      readFailure = null;
    }

    tick(engine.BACKOFF_MAX_MS);
    await pass();

    const row = (await store.getRow(threadId))!;

    assert.equal(row.pollFailures, 0);
    assert.equal(row.watch.warnedAt, null);
    assert.equal((await eventsOf(threadId, ['thread.notification'])).at(-1)?.payload.text, 'The session is watched again.');
  });

  test('a gone session fails the thread, once', async () => {
    const { threadId, ref } = await openThread({ input: 'vanish' });

    session(ref).reads.push({ cursor: 'c1', phase: 'gone', items: [] });
    await pass();
    assert.equal((await store.getRow(threadId))!.phase, 'gone');
    assert.equal((await getThread(threadId))!.status, 'failed');
    assert.deepEqual((await eventsOf(threadId, ['thread.failed'])).map(event => event.payload), [{ error: 'the remote session is gone' }]);
  });

  test('adoption: an unknown session fails the thread; a session with a thread already is refused', async () => {
    const unknownId = randomUUID();
    const unknown = await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: unknownId, targetThreadId: stand.mainThreadId, payload: { agent: 'fake_agent', remote: true, adopt: true, input: 'sess-nope' } });

    assert.equal(await engine.openRemoteThread((await getThread(unknownId))!, unknown.written ? unknown.event : assert.fail()), null);
    assert.equal((await getThread(unknownId))!.status, 'failed');

    const { ref } = await openThread({ input: 'original' });
    const twinId = randomUUID();
    const twin = await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: twinId, targetThreadId: stand.mainThreadId, payload: { agent: 'fake_agent', remote: true, adopt: true, input: ref } });

    assert.equal(await engine.openRemoteThread((await getThread(twinId))!, twin.written ? twin.event : assert.fail()), null);
    assert.deepEqual((await eventsOf(twinId, ['thread.failed'])).map(event => event.payload), [{ error: 'this session already has a thread' }]);
    assert.equal(await store.getRow(twinId), null);
  });

  test('adoption of a free session reads it from the start', async () => {
    sessions.set('sess-free', { reads: [], said: [], answered: [], stopped: 0, readCursors: [], files: {} });

    const { threadId, ref } = await openThread({ adopt: true, input: 'sess-free' });

    assert.equal(ref, 'sess-free');
    assert.equal((await store.getRow(threadId))!.phase, 'idle');
    await pass();
    assert.deepEqual(session('sess-free').readCursors, [null]);
  });

  test('a terminal closes the row without touching the session; a stop reaches the driver', async () => {
    const { threadId, ref } = await openThread({ input: 'stop me' });

    engine.stop(threadId);
    await engine.settled();
    assert.equal(session(ref).stopped, 1);

    const cancelled = await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId, payload: { reason: 'cancelled by the operator' } });

    assert.ok(cancelled.written);
    engine.forget(threadId, 'thread.cancelled');
    await engine.settled();
    assert.equal((await store.getRow(threadId))!.phase, 'closed');
    assert.equal(session(ref).stopped, 1);

    // Nothing is read for a closed row.
    tick(engine.READ_EVERY_MS.working);
    await pass();
    assert.deepEqual(session(ref).readCursors, []);
  });

  test('finish: the session is asked for a closing summary in a turn of its own, whose text completes the thread', async () => {
    const { threadId, ref } = await openThread({ input: 'wrap up' });
    const command = await appendEvent({ type: 'thread.finish', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: { reason: 'finished_by_user' } });

    assert.ok(command.written);
    engine.inbound(threadId, command.event);
    await engine.settled();

    const asked = session(ref).said.at(-1)!;

    assert.equal(asked.text, engine.FINISH_PROMPT);
    assert.equal((await store.getRow(threadId))!.phase, 'finishing');

    // A message meanwhile is not passed on.
    const late = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'one more thing' } });

    assert.ok(late.written);
    engine.inbound(threadId, late.event);
    await engine.settled();
    assert.equal(session(ref).said.at(-1), asked);

    session(ref).reads.push({
      cursor: 'c1',
      phase: 'idle',
      items: [
        { kind: 'turn.started', turnId: 'turn-fin', messageId: asked.messageId },
        { kind: 'prompt', messageId: asked.messageId, text: engine.FINISH_PROMPT },
        { kind: 'text', turnId: 'turn-fin', text: 'Did the thing; nothing remains.' },
        { kind: 'turn.finished', turnId: 'turn-fin', outcome: 'completed', text: 'Did the thing; nothing remains.' },
      ],
    });
    await pass();

    const thread = (await getThread(threadId))!;

    assert.equal(thread.status, 'completed');
    assert.deepEqual(thread.summary, { text: 'Did the thing; nothing remains.' });
    assert.equal((await store.getRow(threadId))!.phase, 'closed');
    // The summary was not told as a reply.
    assert.deepEqual(await eventsOf(threadId, ['agent.message']), []);
  });

  test('finish: a session that never answers completes the thread with its last words after the timeout', async () => {
    const { threadId, ref } = await openThread({ input: 'slow' });

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [{ kind: 'text', turnId: 't', text: 'last words' }, { kind: 'turn.finished', turnId: 't', outcome: 'completed', text: 'last words' }] });
    await pass();

    const command = await appendEvent({ type: 'thread.finish', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: {} });

    assert.ok(command.written);
    engine.inbound(threadId, command.event);
    await engine.settled();
    tick(engine.FINISH_TIMEOUT_MS);
    await pass();

    const thread = (await getThread(threadId))!;

    assert.equal(thread.status, 'completed');
    assert.match(thread.summary!.text, /^last words\n\n\(summary composed by Balabash: the session did not answer\)$/);
  });

  test('an attachment of the owner’s message reaches the driver as a stored file; a message of files alone is said too', async () => {
    const { threadId, ref } = await openThread({ input: 'take this' });
    const stored = await ingestFile({ body: 'hello', originalFilename: 'notes.md', contentType: 'text/markdown', userId: stand.userId, scope: 'web' });
    const message = await appendEvent({
      type: 'user.message',
      actor: 'user',
      userId: stand.userId,
      threadId,
      payload: { text: null, files: [{ fileId: stored.id, originalFilename: 'notes.md' }, { fileId: randomUUID(), originalFilename: 'gone.md' }] },
    });

    assert.ok(message.written);
    engine.inbound(threadId, message.event);
    await engine.settled();
    assert.deepEqual(session(ref).said.at(-1), { text: '', messageId: message.event.id, files: ['notes.md'] });
  });

  test('a file of the session is fetched by path for the owner, stored and shown in the thread; a stranger, a sleeping sandbox and a missing path are refused', async () => {
    const { threadId, ref } = await openThread({ input: 'files' });

    session(ref).files['/workspace/out/report.txt'] = 'the report';

    const file = await engine.fetchRemoteFile(threadId, '/workspace/out/report.txt', { userId: stand.userId, threadId: stand.mainThreadId });

    assert.equal(file.originalFilename, 'report.txt');
    assert.equal(file.userId, stand.userId);
    assert.equal(file.scope, 'fake_agent');

    const shown = (await eventsOf(threadId, ['agent.message'])).at(-1)!.payload as { content: Array<{ type: string; fileId?: string; text?: string }> };

    assert.deepEqual(shown.content.map(block => [block.type, block.fileId ?? block.text]), [['text', '/workspace/out/report.txt'], ['file', file.id]]);

    await assert.rejects(engine.fetchRemoteFile(threadId, '/workspace/out/report.txt', { userId: stand.userId, threadId: randomUUID() }), /not a child of the calling thread/);
    await assert.rejects(engine.fetchRemoteFile(threadId, '/workspace/none', { userId: stand.userId, threadId: stand.mainThreadId }), /not available/);
    await assert.rejects(engine.fetchRemoteFile(randomUUID(), '/x', { userId: stand.userId, threadId: stand.mainThreadId }), /not a remote thread/);
  });

  test('a headless thread tells its parent and relays an ask to it', async () => {
    const parentId = randomUUID();

    await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: parentId, targetThreadId: stand.mainThreadId, payload: { agent: 'engineer', title: 'Parent' } });

    const { threadId, ref } = await openThread({ input: 'for the parent', headless: true }, parentId);

    session(ref).reads.push({
      cursor: 'c1',
      phase: 'asking',
      items: [
        { kind: 'text', turnId: 't', text: 'working on it' },
        { kind: 'ask.opened', askId: 'ask-h', askKind: 'credential', text: 'Connect GitHub', link: 'https://ext/oauth', options: [] },
      ],
    });
    await pass();

    const toParent = await prisma.event.findMany({ where: { threadId, targetThreadId: parentId, type: 'thread.message' }, orderBy: { seq: 'asc' } });

    assert.deepEqual(
      toParent.map(event => (event.payload as JsonObject).text),
      ['working on it', "[Needs a human's decision — relay it to the user, never decide yourself] Connect GitHub — https://ext/oauth"],
    );
    assert.deepEqual(await eventsOf(threadId, ['agent.message', 'thread.notification']), []);

    // A sign-in is not decided by a word.
    const decide = await appendEvent({ type: 'thread.decide', actor: 'agent', agentName: 'engineer', userId: stand.userId, threadId: parentId, targetThreadId: threadId, payload: { askId: 'ask-h', decision: 'allow' } });

    assert.ok(decide.written);
    engine.inbound(threadId, decide.event);
    await engine.settled();
    assert.deepEqual(session(ref).answered, []);
  });
});
