// The remote engine over the stand (src/test-support/stand.ts) with a fake
// driver in memory: a thread opens a session (the row, session.started,
// our opening prompt's id for the echo); a read is mirrored atomically with
// the cursor; the owner's message reaches the driver as say with our id, a
// reply mirrored from the other side never goes back; an ask opens act and
// a decision resolves it through the driver; a long idle pauses the thread
// and a message wakes it; a failing watch backs off and tells the owner
// once after two hours; a gone session fails the thread; a second thread
// for one session is refused; a terminal closes the row without touching
// the session — a terminal the process never routed too (after a restart);
// the inbound events are applied from the log by the row's position, never
// from memory; a redelivered thread.started opens nothing twice; a queued
// read never overwrites what a verb did meanwhile; the opening runs off
// the router, bounded in time; a kind not loaded steps aside for the
// healthy rows; the closing summary outstanding survives an idle read.
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
// A gate the tests close to hold the driver's reads / opens in flight.
let holdReads: Promise<void> | null = null;
let holdOpen: Promise<void> | null = null;
// What describe hands over as the position of the present.
let describeCursor: unknown;

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

    if (holdOpen) {
      await holdOpen;
    }

    session(ref).said.push({ text: input.prompt, messageId: input.messageId, ...(input.files.length ? { files: input.files.map(file => file.originalFilename ?? file.id) } : {}) });

    return { ref, link: `https://ext/${ref}` };
  },
  describe: async (_ctx, ref) => ({ exists: sessions.has(ref), link: `https://ext/${ref}`, ...(describeCursor !== undefined ? { cursor: describeCursor as never } : {}) }),
  read: async (_ctx, { ref, cursor }) => {
    if (readFailure) {
      throw new Error(readFailure);
    }

    const current = session(ref);

    current.readCursors.push(cursor);

    if (holdReads) {
      await holdReads;
    }

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
    verbTimeoutMs: 300,
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

  assert.ok(run, 'the facade is handed over at once');
  await engine.settled();

  const row = await store.getRow(threadId);

  assert.ok(row, 'the thread opened');

  return { threadId, started: result.event, ref: row.ref };
}

// The same, for a thread whose opening is expected to fail: the facade
// is handed over, the failure is the thread's terminal.
async function openFailing(payload: JsonObject): Promise<string> {
  const threadId = randomUUID();
  const result = await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId, targetThreadId: stand.mainThreadId, payload: { agent: 'fake_agent', title: 'Remote', remote: true, ...payload } });

  assert.ok(result.written);
  assert.ok(await engine.openRemoteThread((await getThread(threadId))!, result.event));
  await engine.settled();

  return threadId;
}

async function until(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;

  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// The other tests' live rows out of the way of a pass that counts.
async function parkOtherRows(): Promise<void> {
  await prisma.remoteThread.updateMany({ where: { phase: { in: store.LIVE_PHASES } }, data: { nextPollAt: new Date(clock.getTime() + 365 * 24 * 60 * 60_000) } });
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
    engine.wake(threadId);
    await engine.settled();

    const row = (await store.getRow(threadId))!;

    // The attachment names a file that is not stored: dropped, the text goes.
    assert.deepEqual(session(ref).said.at(-1), { text: 'and z', messageId: message.event.id });
    assert.equal(row.phase, 'working');
    assert.ok(row.watch.ownMessageIds.includes(message.event.id));
    assert.deepEqual((await eventsOf(threadId, ['session.state'])).map(event => event.payload.state), ['run', 'wait', 'run']);

    const foreign = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'from context', source: 'remote', identity: { username: 'alice' } } });

    assert.ok(foreign.written);
    engine.wake(threadId);
    await engine.settled();
    assert.equal(session(ref).said.length, 2);

    // The parent's thread.message is the owner's voice too.
    const fromParent = await appendEvent({ type: 'thread.message', actor: 'agent', agentName: 'coordinator', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: { text: 'parent says' } });

    assert.ok(fromParent.written);
    engine.wake(threadId);
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
    engine.wake(threadId);
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
    engine.wake(threadId);
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

  test('adoption: an unknown session fails the thread; a session with a live thread already is refused, the thread named', async () => {
    const unknownId = await openFailing({ adopt: true, input: 'sess-nope' });

    assert.equal((await getThread(unknownId))!.status, 'failed');
    assert.deepEqual((await eventsOf(unknownId, ['thread.failed'])).map(event => event.payload), [{ error: 'unknown remote session' }]);

    const { threadId, ref } = await openThread({ input: 'original' });
    const twinId = await openFailing({ adopt: true, input: ref });

    assert.deepEqual((await eventsOf(twinId, ['thread.failed'])).map(event => event.payload), [{ error: `this session already has a thread: ${threadId}` }]);
    assert.equal(await store.getRow(twinId), null);
  });

  test('adoption: the driver may hand the position of the present; a session whose thread ended can be adopted again', async () => {
    sessions.set('sess-again', { reads: [], said: [], answered: [], stopped: 0, readCursors: [], files: {} });
    describeCursor = { rows: 7 };

    try {
      const { threadId } = await openThread({ adopt: true, input: 'sess-again' });

      assert.deepEqual((await store.getRow(threadId))!.cursor, { rows: 7 });
      await pass();
      assert.deepEqual(session('sess-again').readCursors, [{ rows: 7 }]);

      await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId, payload: { reason: 'by mistake' } });
      engine.forget(threadId, 'thread.cancelled');
      await engine.settled();
      assert.equal((await store.getRow(threadId))!.phase, 'closed');
    } finally {
      describeCursor = undefined;
    }

    const again = await openThread({ adopt: true, input: 'sess-again' });

    assert.equal(again.ref, 'sess-again');
    assert.equal((await store.getRow(again.threadId))!.phase, 'idle');
  });

  test('a redelivered thread.started opens no second session and leaves the thread as it is', async () => {
    const { threadId, started, ref } = await openThread({ input: 'once' });
    const before = opens;

    assert.ok(await engine.openRemoteThread((await getThread(threadId))!, started));
    await engine.settled();
    assert.equal(opens, before);
    assert.equal((await getThread(threadId))!.status, 'active');
    assert.equal((await store.getRow(threadId))!.ref, ref);
  });

  test('the opening runs off the router and is bounded in time: a stalled open fails its thread alone', async () => {
    let release!: () => void;

    holdOpen = new Promise<void>(resolve => {
      release = resolve;
    });

    const threadId = randomUUID();
    const started = await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId, targetThreadId: stand.mainThreadId, payload: { agent: 'fake_agent', remote: true, input: 'slow open' } });

    assert.ok(started.written);
    assert.ok(await engine.openRemoteThread((await getThread(threadId))!, started.event), 'the facade is handed over while the open is in flight');
    assert.equal(await store.getRow(threadId), null);
    release();
    await engine.settled();
    assert.ok(await store.getRow(threadId));

    holdOpen = new Promise<void>(() => {});

    try {
      const stalled = await openFailing({ input: 'never opens' });

      assert.equal((await getThread(stalled))!.status, 'failed');
      assert.match((await eventsOf(stalled, ['thread.failed']))[0]!.payload.error as string, /open timed out after 300 ms/);
    } finally {
      holdOpen = null;
    }
  });

  test('a terminal this process never routed closes the row at the next service: nothing is read into a cancelled thread', async () => {
    const { threadId, ref } = await openThread({ input: 'orphaned' });

    session(ref).reads.push({ cursor: 'c1', phase: 'working', items: [{ kind: 'text', turnId: 't', text: 'still going' }] });

    // The terminal is in the log; no facade in memory saw it (a restart).
    await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId, payload: { reason: 'cancelled after a restart' } });
    tick(engine.READ_EVERY_MS.working);
    await pass();

    assert.equal((await store.getRow(threadId))!.phase, 'closed');
    assert.deepEqual(session(ref).readCursors, []);
    assert.deepEqual(await eventsOf(threadId, ['agent.message']), []);

    // The inbound side finds it too.
    const other = await openThread({ input: 'orphaned too' });

    await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId: other.threadId, payload: { reason: 'cancelled' } });
    engine.wake(other.threadId);
    await engine.settled();
    assert.equal((await store.getRow(other.threadId))!.phase, 'closed');
  });

  test('a parent’s cascade takes the remote child along, row included', async () => {
    const parentId = randomUUID();

    await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: parentId, targetThreadId: stand.mainThreadId, payload: { agent: 'engineer', title: 'Parent' } });

    const { threadId } = await openThread({ input: 'child', headless: true }, parentId);

    await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId: parentId, payload: { reason: 'parent over' } });
    assert.equal((await getThread(threadId))!.status, 'cancelled');
    tick(engine.READ_EVERY_MS.working);
    await pass();
    assert.equal((await store.getRow(threadId))!.phase, 'closed');
  });

  test('the owner’s message is applied from the log by the row’s position, not from memory: the heart and the boot sweep serve what a dead process left', async () => {
    const { threadId, ref } = await openThread({ input: 'durable' });
    const first = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'first' } });

    assert.ok(first.written);
    // No wake: the process that acknowledged the event in the router died.
    tick(engine.READ_EVERY_MS.working);
    await pass();
    assert.deepEqual(session(ref).said.at(-1), { text: 'first', messageId: first.event.id });
    assert.equal((await store.getRow(threadId))!.inboundSeq, first.event.seq);

    const second = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'second' } });

    assert.ok(second.written);
    await engine.sweepRemoteThreads();
    await engine.settled();
    assert.deepEqual(session(ref).said.at(-1), { text: 'second', messageId: second.event.id });
    assert.equal((await store.getRow(threadId))!.inboundSeq, second.event.seq);

    // Served once: a second sweep says nothing again.
    await engine.sweepRemoteThreads();
    await engine.settled();
    assert.equal(session(ref).said.length, 3);
  });

  test('a queued read does not overwrite what an inbound verb remembered meanwhile', async () => {
    await parkOtherRows();

    const threads: Array<Awaited<ReturnType<typeof openThread>>> = [];

    for (let i = 0; i < engine.READS_IN_FLIGHT + 1; i += 1) {
      threads.push(await openThread({ input: `race ${i}` }));
    }

    let release!: () => void;

    holdReads = new Promise<void>(resolve => {
      release = resolve;
    });

    const passing = engine.runRemotePass();

    await until(() => threads.filter(thread => session(thread.ref).readCursors.length === 1).length === engine.READS_IN_FLIGHT, 'the reads in flight');

    const fifth = threads.find(thread => session(thread.ref).readCursors.length === 0)!;
    const message = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId: fifth.threadId, payload: { text: 'while the read waits' } });

    assert.ok(message.written);
    engine.wake(fifth.threadId);
    await until(() => session(fifth.ref).said.length === 2, 'the message said');

    release();
    holdReads = null;
    await passing;
    await engine.settled();

    const row = (await store.getRow(fifth.threadId))!;

    assert.ok(row.watch.ownMessageIds.includes(message.event.id), 'the read kept the id the verb remembered');
    assert.equal(session(fifth.ref).readCursors.length, 1);
  });

  test('finish: an idle read before the summary’s turn keeps the thread finishing; the deadline completes it', async () => {
    const { threadId, ref } = await openThread({ input: 'patient' });
    const command = await appendEvent({ type: 'thread.finish', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: {} });

    assert.ok(command.written);
    engine.wake(threadId);
    await engine.settled();
    assert.equal((await store.getRow(threadId))!.phase, 'finishing');

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [] });
    tick(engine.READ_EVERY_MS.finishing);
    await pass();

    const row = (await store.getRow(threadId))!;

    assert.equal(row.phase, 'finishing');
    assert.ok(row.watch.finish);

    const late = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'too late' } });

    assert.ok(late.written);
    engine.wake(threadId);
    await engine.settled();
    assert.equal(session(ref).said.at(-1)!.text, engine.FINISH_PROMPT);

    tick(engine.FINISH_TIMEOUT_MS);
    await pass();
    assert.equal((await getThread(threadId))!.status, 'completed');
    assert.equal((await store.getRow(threadId))!.phase, 'closed');
  });

  test('finish: a driver naming no prompt — the first turn after the ask is the summary’s', async () => {
    const { threadId, ref } = await openThread({ input: 'nameless' });
    const command = await appendEvent({ type: 'thread.finish', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: {} });

    assert.ok(command.written);
    engine.wake(threadId);
    await engine.settled();

    session(ref).reads.push({
      cursor: 'c1',
      phase: 'idle',
      items: [
        { kind: 'turn.started', turnId: 'turn-x' },
        { kind: 'text', turnId: 'turn-x', text: 'All done.' },
        { kind: 'turn.finished', turnId: 'turn-x', outcome: 'completed', text: 'All done.' },
      ],
    });
    await pass();

    const thread = (await getThread(threadId))!;

    assert.equal(thread.status, 'completed');
    assert.deepEqual(thread.summary, { text: 'All done.' });
    assert.deepEqual(await eventsOf(threadId, ['agent.message']), []);
  });

  test('pause: only a waiting thread sleeps; a working one is told why', async () => {
    const { threadId, ref } = await openThread({ input: 'busy' });
    const pauseNow = async () => {
      const command = await appendEvent({ type: 'thread.pause', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, targetThreadId: threadId, payload: {} });

      assert.ok(command.written);
      engine.wake(threadId);
      await engine.settled();
    };

    await pauseNow();
    assert.equal((await store.getRow(threadId))!.phase, 'working');
    assert.deepEqual((await eventsOf(threadId, ['thread.notification'])).map(event => event.payload), [{ level: 'normal', text: 'The thread was not paused: the session is working — stop the turn first.' }]);

    session(ref).reads.push({ cursor: 'c1', phase: 'idle', items: [{ kind: 'turn.finished', turnId: 't', outcome: 'completed', text: '' }] });
    await pass();
    await pauseNow();
    assert.equal((await store.getRow(threadId))!.phase, 'paused');
    assert.equal((await eventsOf(threadId, ['session.state'])).at(-1)?.payload.state, 'paused');
  });

  test('rows of a kind that is not loaded step aside: the healthy row behind them is read', async () => {
    await parkOtherRows();

    for (let i = 0; i < engine.ROWS_PER_PASS; i += 1) {
      const threadId = randomUUID();
      const started = await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId, targetThreadId: stand.mainThreadId, payload: { agent: 'dead_agent', title: 'Dead', remote: true, input: 'x' } });

      assert.ok(started.written);
      await store.createRow(
        { threadId, userId: stand.userId, kind: 'dead_agent', ref: `dead-${i}`, link: null, watch: store.initialWatch({ headless: false, parentId: stand.mainThreadId, notification: 'normal' }), phase: 'working', inboundSeq: started.event.seq, nextPollAt: new Date(clock.getTime() - 60_000) },
        [],
      );
    }

    const { ref } = await openThread({ input: 'healthy' });

    // The first pass is theirs (the longest waiting first) — and it is
    // their last for a quarter of an hour; the healthy row waits one pass
    // at most.
    await pass();

    const dead = await prisma.remoteThread.findMany({ where: { kind: 'dead_agent' } });

    assert.equal(dead.length, engine.ROWS_PER_PASS);
    assert.ok(dead.every(row => row.nextPollAt.getTime() === clock.getTime() + engine.UNLOADED_KIND_RETRY_MS));
    assert.equal((await prisma.event.findMany({ where: { type: 'system.exception', payload: { path: ['scope'], equals: 'remote-agents' } } })).length, 1);
    assert.deepEqual(session(ref).readCursors, []);

    await pass();
    assert.deepEqual(session(ref).readCursors, [null]);
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
    engine.wake(threadId);
    await engine.settled();

    const asked = session(ref).said.at(-1)!;

    assert.equal(asked.text, engine.FINISH_PROMPT);
    assert.equal((await store.getRow(threadId))!.phase, 'finishing');

    // A message meanwhile is not passed on.
    const late = await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId, payload: { text: 'one more thing' } });

    assert.ok(late.written);
    engine.wake(threadId);
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
    engine.wake(threadId);
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
    engine.wake(threadId);
    await engine.settled();
    assert.deepEqual(session(ref).said.at(-1), { text: '', messageId: message.event.id, files: ['notes.md'] });
  });

  test('an attachment of the spawn prompt reaches the driver at open as a stored file; a missing one is skipped', async () => {
    const stored = await ingestFile({ body: 'brief', originalFilename: 'brief.md', contentType: 'text/markdown', userId: stand.userId, scope: 'web' });
    const { started, ref } = await openThread({ input: 'read the brief', fileIds: [stored.id, randomUUID()], files: [{ fileId: stored.id, originalFilename: 'brief.md' }, { fileId: randomUUID(), originalFilename: 'gone.md' }] });

    assert.deepEqual(session(ref).said, [{ text: 'read the brief', messageId: started.id, files: ['brief.md'] }]);
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
    engine.wake(threadId);
    await engine.settled();
    assert.deepEqual(session(ref).answered, []);
  });
});
