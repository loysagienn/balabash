// The thread commands of the console over the stand (src/test-support/
// stand.ts): POST /api/threads/:id/interrupt and /cancel write the one-hop
// command from the parent in the operator's name and leave the terminal to
// the router (the stand runs none — the thread stays active); the main
// thread, a closed thread, a thread closed between the handler's check and
// its write, and an unknown one are refused with nothing written.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Reply, Stand } from '../test-support/stand.ts';
import type { ThreadCommandResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };
type Command = { type: string; actor: string; agentName: string | null; threadId: string | null; payload: Record<string, unknown> };

const COMMANDS = ['interrupt', 'cancel'] as const;

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let appendEventIn: typeof import('../core/append.ts')['appendEventIn'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent, appendEventIn } = await import('../core/append.ts'));
});

after(() => stand.stop());

// A child of the main thread, started the way a spawn starts it: the
// thread.started is authored by the new thread and addressed to the parent.
async function startChild(title: string): Promise<string> {
  const id = randomUUID();

  await appendEvent({
    type: 'thread.started',
    actor: 'system',
    userId: stand.userId,
    threadId: id,
    targetThreadId: stand.mainThreadId,
    payload: { agent: 'engineer', title },
  });

  return id;
}

async function closeThread(id: string): Promise<void> {
  const result = await appendEvent({ type: 'thread.completed', actor: 'system', userId: stand.userId, threadId: id, payload: { summary: { text: 'done' } } });

  assert.equal(result.written, true);
}

async function threadStatus(id: string): Promise<string> {
  return (await prisma.thread.findUniqueOrThrow({ where: { id } })).status;
}

// The commands addressed to a thread, in log order.
async function commandsTo(targetThreadId: string): Promise<Command[]> {
  const rows = await prisma.event.findMany({ where: { targetThreadId, type: { in: ['thread.interrupt', 'thread.cancel'] } }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ type: row.type, actor: row.actor, agentName: row.agentName, threadId: row.threadId, payload: row.payload as Record<string, unknown> }));
}

describe('thread commands over the api', () => {
  test('interrupt writes thread.interrupt from the parent in the operator’s name; the thread stays active', async () => {
    const child = await startChild('Interrupted');
    const reply = await stand.request('POST', `/api/threads/${child}/interrupt`);

    assert.equal(reply.status, 200, reply.text);

    const { event } = reply.json<ThreadCommandResponse>();

    assert.deepEqual(
      { type: event.type, actor: event.actor, agentName: event.agentName, userId: event.userId, threadId: event.threadId, targetThreadId: event.targetThreadId, payload: event.payload },
      {
        type: 'thread.interrupt',
        actor: 'user',
        agentName: null,
        userId: stand.userId,
        threadId: stand.mainThreadId,
        targetThreadId: child,
        payload: { reason: 'interrupted_by_user', identity: { username: 'operator' }, source: 'web' },
      },
    );
    assert.equal(typeof event.seq, 'bigint');
    assert.ok(event.createdAt instanceof Date);

    const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });

    assert.equal(row.seq, event.seq);
    assert.equal(row.targetThreadId, child);
    // The command is a command: the run's soft stop, no terminal.
    assert.equal(await threadStatus(child), 'active');
  });

  test('cancel writes thread.cancel with the reason trimmed or the default; the terminal is the router’s to write', async () => {
    const child = await startChild('Cancelled');
    const reasoned = await stand.request('POST', `/api/threads/${child}/cancel`, { body: { reason: '  wrong task  ' } });

    assert.equal(reasoned.status, 200, reasoned.text);

    const { event } = reasoned.json<ThreadCommandResponse>();

    assert.equal(event.type, 'thread.cancel');
    assert.equal(event.threadId, stand.mainThreadId);
    assert.equal(event.targetThreadId, child);
    assert.deepEqual(event.payload, { reason: 'wrong task', identity: { username: 'operator' }, source: 'web' });

    const bare = await stand.request('POST', `/api/threads/${child}/cancel`);

    assert.equal(bare.status, 200, bare.text);

    const blank = await stand.request('POST', `/api/threads/${child}/cancel`, { body: { reason: '   ' } });

    assert.equal(blank.status, 200, blank.text);

    const commands = await commandsTo(child);

    assert.deepEqual(
      commands.map(command => [command.type, command.actor, command.agentName, command.threadId, command.payload.reason]),
      [
        ['thread.cancel', 'user', null, stand.mainThreadId, 'wrong task'],
        ['thread.cancel', 'user', null, stand.mainThreadId, 'cancelled by the operator'],
        ['thread.cancel', 'user', null, stand.mainThreadId, 'cancelled by the operator'],
      ],
    );
    // The stand runs no router: the command is in the log and the thread
    // is still active — thread.cancelled is the router's, not the handler's.
    assert.equal(await threadStatus(child), 'active');
  });

  test('a reason over the cap or a body that is not an object is refused with nothing written', async () => {
    const child = await startChild('Refused');
    const long = await stand.request('POST', `/api/threads/${child}/cancel`, { body: { reason: 'x'.repeat(1_001) } });

    assert.equal(long.status, 400);
    assert.equal(long.json<ErrorBody>().error.code, 'bad_request');
    assert.match(long.json<ErrorBody>().error.message, /at most 1000 characters/);

    const array = await stand.request('POST', `/api/threads/${child}/cancel`, { text: '[1]' });

    assert.equal(array.status, 400);

    const corrupted = await stand.request('POST', `/api/threads/${child}/cancel`, { text: '{"reason": ' });

    assert.equal(corrupted.status, 400);
    assert.deepEqual(await commandsTo(child), []);

    const atCap = await stand.request('POST', `/api/threads/${child}/cancel`, { body: { reason: 'y'.repeat(1_000) } });

    assert.equal(atCap.status, 200, atCap.text);
    assert.equal((await commandsTo(child)).length, 1);
  });

  test('the main thread takes neither command', async () => {
    for (const command of COMMANDS) {
      const reply = await stand.request('POST', `/api/threads/${stand.mainThreadId}/${command}`);

      assert.equal(reply.status, 409, `${command}: ${reply.text}`);
      assert.equal(reply.json<ErrorBody>().error.code, 'thread_main');
    }

    assert.deepEqual(await commandsTo(stand.mainThreadId), []);
  });

  test('a closed thread answers thread_closed, an unknown one not_found — no command either way', async () => {
    const child = await startChild('Closed');

    await closeThread(child);

    for (const command of COMMANDS) {
      const closed = await stand.request('POST', `/api/threads/${child}/${command}`);

      assert.equal(closed.status, 409, `${command}: ${closed.text}`);
      assert.equal(closed.json<ErrorBody>().error.code, 'thread_closed');

      const unknown = await stand.request('POST', `/api/threads/${randomUUID()}/${command}`);

      assert.equal(unknown.status, 404, `${command}: ${unknown.text}`);
      assert.equal(unknown.json<ErrorBody>().error.code, 'not_found');
    }

    assert.deepEqual(await commandsTo(child), []);
  });

  for (const command of COMMANDS) {
    // The test holds the thread's row lock in a transaction of its own: the
    // handler's check (an unlocked read) sees the thread active, its append
    // then waits for the lock — and what it sees once the lock is released
    // is the terminal this transaction committed meanwhile. Every wait here
    // ends with a failure of what it waits for: the holding transaction
    // failing releases the wait for the lock, the request failing or
    // answering early ends the wait for the handler, and the cleanup lets
    // the transaction go and aborts the request whatever happened — the
    // test's own timeout is the last resort, never the first.
    test(`a thread closed between the handler’s check and its write answers thread_closed to ${command}, and the log keeps no command`, { timeout: 30_000 }, async () => {
      const child = await startChild(`Racing ${command}`);
      let locked!: () => void;
      let lockLost!: (reason: unknown) => void;
      const lockHeld = new Promise<void>((resolve, reject) => {
        locked = resolve;
        lockLost = reject;
      });
      let terminate!: () => void;
      let abandon!: (reason: unknown) => void;
      const terminal = new Promise<void>((resolve, reject) => {
        terminate = resolve;
        abandon = reject;
      });
      const held = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${child} FOR UPDATE`;
          locked();
          await terminal;

          const result = await appendEventIn(tx, { type: 'thread.completed', actor: 'system', userId: stand.userId, threadId: child, payload: { summary: { text: 'done first' } } });

          assert.equal(result.written, true);
        },
        { timeout: 20_000 },
      );

      // A transaction that fails before the lock ends the wait for it with
      // its own reason (a no-op once the lock was taken).
      held.catch(lockLost);

      const aborter = new AbortController();
      let reply: Promise<Reply> | null = null;

      try {
        await lockHeld;
        reply = stand.request('POST', `/api/threads/${child}/${command}`, { body: { reason: 'too late' }, signal: aborter.signal });
        await Promise.race([
          waitForLockWaiter(),
          failureOf(held),
          reply.then(early => {
            throw new Error(`the handler answered before the lock was released: ${early.status} ${early.text}`);
          }),
        ]);
        terminate();
        await held;

        const refused = await reply;

        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json<ErrorBody>().error.code, 'thread_closed');
        assert.deepEqual(await commandsTo(child), []);
        assert.equal(await threadStatus(child), 'completed');
      } finally {
        // Whatever ended the test: the holding transaction is let go (a
        // rejection rolls it back and frees the handler), the request is
        // aborted, and both are awaited — nothing of the scenario outlives
        // the test; the test's own error stays the one reported.
        abandon(new Error('the scenario is over'));
        aborter.abort();
        await Promise.allSettled([held, reply]);
      }
    });
  }
});

// A promise that rejects when the given one does and never resolves — to
// race a wait against the failure of what it depends on.
function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}));
}

// Until a session of the stand's database waits for a lock — the handler's
// append blocked on the row the test holds. Each probe is one short query;
// the deadline bounds the loop, the test's timeout bounds the rest.
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;

    if (row && row.n > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.fail('the handler never waited for the lock');
}
