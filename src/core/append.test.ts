// The write point of the log over the stand's database (src/test-support/
// stand.ts): a thread has exactly one terminal whoever races for it, a
// command for a closed child is a no-op, a terminal cancels the active
// subtree in its own transaction, a spawn racing the parent's terminal
// never leaves an active orphan, and a registry change commits with its
// event or not at all — the events of one row in the row's order.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { JsonObject } from './contract.ts';

type Lifecycle = { seq: bigint; type: string; actor: string; threadId: string | null; targetThreadId: string | null; payload: JsonObject };

const TERMINALS = ['thread.completed', 'thread.failed', 'thread.cancelled'];

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('./append.ts')['appendEvent'];
let AppendError: typeof import('./envelope.ts')['AppendError'];
let registryMutation: typeof import('./registry-events.ts')['registryMutation'];
let projectRecord: typeof import('../projects/store.ts')['projectRecord'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('./append.ts'));
  ({ AppendError } = await import('./envelope.ts'));
  ({ registryMutation } = await import('./registry-events.ts'));
  ({ projectRecord } = await import('../projects/store.ts'));
});

after(() => stand.stop());

// thread.started the way a spawn writes it: authored by the new thread,
// addressed to the parent.
function start(id: string, parentId: string, agent = 'engineer') {
  return appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: id, targetThreadId: parentId, payload: { agent, title: id } });
}

async function startChild(parentId = stand.mainThreadId, agent = 'engineer'): Promise<string> {
  const id = randomUUID();

  await start(id, parentId, agent);

  return id;
}

function complete(threadId: string, text = 'done') {
  return appendEvent({ type: 'thread.completed', actor: 'system', userId: stand.userId, threadId, payload: { summary: { text } } });
}

function fail(threadId: string) {
  return appendEvent({ type: 'thread.failed', actor: 'system', userId: stand.userId, threadId, payload: { error: 'boom' } });
}

function command(type: 'thread.cancel' | 'thread.interrupt', threadId: string, targetThreadId: string) {
  return appendEvent({ type, actor: 'system', userId: stand.userId, threadId, targetThreadId, payload: { reason: 'test' } });
}

async function threadRow(id: string): Promise<{ status: string; terminalSeq: bigint | null } | null> {
  const row = await prisma.thread.findUnique({ where: { id }, select: { status: true, terminalSeq: true } });

  return row;
}

// The lifecycle events of the given threads, in log order.
async function lifecycleOf(threadIds: string[]): Promise<Lifecycle[]> {
  const rows = await prisma.event.findMany({ where: { threadId: { in: threadIds }, type: { startsWith: 'thread.' } }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ seq: row.seq, type: row.type, actor: row.actor, threadId: row.threadId, targetThreadId: row.targetThreadId, payload: row.payload as JsonObject }));
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppendError, `expected an AppendError, got ${String(error)}`);

    return error.code;
  }

  assert.fail('expected a refusal');
}

describe('terminals', () => {
  test('exactly one: two at once — one written, the other a no-op; a later one of another kind changes nothing', async () => {
    const child = await startChild();
    const results = await Promise.all([complete(child), fail(child)]);
    const written = results.filter(result => result.written);

    assert.equal(written.length, 1);
    assert.deepEqual(
      results.find(result => !result.written),
      { written: false, reason: 'already_terminal' },
    );

    const [terminal] = written;
    const row = await threadRow(child);

    assert.ok(terminal?.written);
    assert.deepEqual(row, { status: terminal.event.type.slice('thread.'.length), terminalSeq: terminal.event.seq });
    assert.equal((await lifecycleOf([child])).filter(event => TERMINALS.includes(event.type)).length, 1);

    const later = await appendEvent({ type: 'thread.cancelled', actor: 'system', userId: stand.userId, threadId: child, payload: { reason: 'late' } });

    assert.deepEqual(later, { written: false, reason: 'already_terminal' });
    assert.deepEqual(await threadRow(child), row);
    assert.equal((await lifecycleOf([child])).filter(event => TERMINALS.includes(event.type)).length, 1);
  });

  test('the main thread takes none; a spawn under a closed parent and a terminal of an unknown thread are refused', async () => {
    assert.equal(await refusal(complete(stand.mainThreadId)), 'main_thread_terminal');
    assert.equal((await threadRow(stand.mainThreadId))?.status, 'active');

    const closed = await startChild();

    await complete(closed);

    const orphan = randomUUID();

    assert.equal(await refusal(start(orphan, closed)), 'parent_terminated');
    assert.equal(await threadRow(orphan), null);
    assert.equal(await refusal(complete(randomUUID())), 'thread_not_found');
  });
});

describe('commands', () => {
  test('a command for a closed child is a no-op without an event; one for a grandchild or an unknown thread is refused', async () => {
    const child = await startChild();
    const grandchild = await startChild(child);

    await complete(child); // cascades onto the grandchild

    assert.deepEqual(await command('thread.cancel', stand.mainThreadId, child), { written: false, reason: 'target_already_terminal' });
    assert.deepEqual(await command('thread.interrupt', stand.mainThreadId, child), { written: false, reason: 'target_already_terminal' });
    assert.equal(await prisma.event.count({ where: { type: { in: ['thread.cancel', 'thread.interrupt'] }, targetThreadId: child } }), 0);

    const open = await startChild();
    const openGrandchild = await startChild(open);

    assert.equal(await refusal(command('thread.cancel', stand.mainThreadId, openGrandchild)), 'one_hop');
    assert.equal(await refusal(command('thread.interrupt', stand.mainThreadId, randomUUID())), 'target_not_found');
    assert.equal(await prisma.event.count({ where: { type: { in: ['thread.cancel', 'thread.interrupt'] }, targetThreadId: { in: [grandchild, openGrandchild] } } }), 0);

    const written = await command('thread.cancel', open, openGrandchild);

    assert.equal(written.written, true);
    assert.equal((await threadRow(openGrandchild))?.status, 'active');
  });
});

describe('the cascade', () => {
  test('a terminal cancels the active subtree in one transaction: one thread.cancelled per descendant, closed ones untouched, in creation order', async () => {
    const child = await startChild();
    const first = await startChild(child);
    const closedSibling = await startChild(child);
    const grandchild = await startChild(first);
    const closedBefore = await complete(closedSibling);

    assert.ok(closedBefore.written);

    const terminal = await complete(child, 'child done');

    assert.ok(terminal.written);

    const cascade = (await lifecycleOf([first, closedSibling, grandchild])).filter(event => event.seq > terminal.event.seq);

    assert.deepEqual(
      cascade.map(event => [event.seq, event.type, event.actor, event.threadId, event.targetThreadId, event.payload]),
      [
        [terminal.event.seq + 1n, 'thread.cancelled', 'system', first, child, { reason: 'parent_terminated', cascadeFromThreadId: child }],
        [terminal.event.seq + 2n, 'thread.cancelled', 'system', grandchild, first, { reason: 'parent_terminated', cascadeFromThreadId: child }],
      ],
    );
    assert.deepEqual(await threadRow(child), { status: 'completed', terminalSeq: terminal.event.seq });
    assert.deepEqual(await threadRow(first), { status: 'cancelled', terminalSeq: terminal.event.seq + 1n });
    assert.deepEqual(await threadRow(grandchild), { status: 'cancelled', terminalSeq: terminal.event.seq + 2n });
    assert.deepEqual(await threadRow(closedSibling), { status: 'completed', terminalSeq: closedBefore.event.seq });
  });

  test('a spawn racing the parent’s terminal is either refused or cancelled with it — never left active', async () => {
    const outcomes = { refused: 0, cancelled: 0 };

    for (let round = 0; round < 5; round += 1) {
      const parent = await startChild();
      const spawned = randomUUID();
      const [spawn, terminal] = await Promise.allSettled([start(spawned, parent), complete(parent)]);

      assert.equal(terminal.status, 'fulfilled');
      assert.ok(terminal.status === 'fulfilled' && terminal.value.written);

      if (spawn.status === 'rejected') {
        assert.ok(spawn.reason instanceof AppendError && spawn.reason.code === 'parent_terminated', String(spawn.reason));
        assert.equal(await threadRow(spawned), null);
        outcomes.refused += 1;
      } else {
        const cascade = (await lifecycleOf([spawned])).filter(event => event.type === 'thread.cancelled');

        assert.equal(cascade.length, 1);
        assert.deepEqual(cascade[0]?.payload, { reason: 'parent_terminated', cascadeFromThreadId: parent });
        assert.deepEqual(await threadRow(spawned), { status: 'cancelled', terminalSeq: cascade[0]?.seq ?? null });
        outcomes.cancelled += 1;
      }

      assert.equal(await prisma.thread.count({ where: { parentId: parent, status: 'active' } }), 0);
    }

    assert.equal(outcomes.refused + outcomes.cancelled, 5);
  });
});

describe('registryMutation', () => {
  let projectId: string;

  before(async () => {
    projectId = (await prisma.project.create({ data: { userId: stand.userId, title: 'Registry', slug: 'registry', description: 'd' } })).id;
  });

  async function updates(): Promise<{ actor: string; agentName: string | null; threadId: string | null; title: string }[]> {
    const rows = await prisma.event.findMany({ where: { type: 'project.updated' }, orderBy: { seq: 'asc' } });

    return rows
      .filter(row => (row.payload as { id: string }).id === projectId)
      .map(row => ({ actor: row.actor, agentName: row.agentName, threadId: row.threadId, title: (row.payload as { title: string }).title }));
  }

  test('the author sets the actor: an agent’s thread, the operator, the core', async () => {
    const thread = await startChild(stand.mainThreadId, 'gardener');

    for (const [title, by] of [
      ['By thread', { kind: 'thread', userId: stand.userId, threadId: thread }],
      ['By user', { kind: 'user', userId: stand.userId }],
      ['By system', { kind: 'system', userId: stand.userId }],
    ] as const) {
      await registryMutation(async (tx, journal) => {
        const row = await tx.project.update({ where: { id: projectId }, data: { title } });

        await journal('project.updated', projectRecord(row), by);
      });
    }

    assert.deepEqual(await updates(), [
      { actor: 'agent', agentName: 'gardener', threadId: thread, title: 'By thread' },
      { actor: 'user', agentName: null, threadId: null, title: 'By user' },
      { actor: 'system', agentName: null, threadId: null, title: 'By system' },
    ]);
  });

  test('a change that fails after its journal leaves neither the row nor the event', async () => {
    await assert.rejects(
      registryMutation(async (tx, journal) => {
        const row = await tx.project.update({ where: { id: projectId }, data: { title: 'Lost' } });

        await journal('project.updated', projectRecord(row), { kind: 'user', userId: stand.userId });
        throw new Error('the change failed after the journal');
      }),
      /failed after the journal/,
    );

    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).title, 'By system');
    assert.equal((await updates()).length, 3);
  });

  test('concurrent changes of one row reach the log in the row’s order: the last event by seq is the row', async () => {
    for (let round = 0; round < 4; round += 1) {
      const titles = Array.from({ length: 6 }, (_, i) => `Round ${round} change ${i}`);

      await Promise.all(
        titles.map(title =>
          registryMutation(async (tx, journal) => {
            const row = await tx.project.update({ where: { id: projectId }, data: { title } });

            await journal('project.updated', projectRecord(row), { kind: 'user', userId: stand.userId });
          }),
        ),
      );

      const events = (await updates()).slice(-titles.length);
      const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

      assert.deepEqual(events.map(event => event.title).sort(), [...titles].sort());
      assert.equal(events.at(-1)?.title, row.title);
    }

    const last = (await prisma.event.findMany({ where: { type: 'project.updated' }, orderBy: { seq: 'desc' }, take: 1 }))[0];
    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    assert.deepEqual(last?.payload, projectRecord(row));
  });
});

describe('the payload', () => {
  test('a string carrying U+0000 — which jsonb cannot hold — is stored with U+FFFD in its place, keys included, the rest untouched', async () => {
    const childId = await startChild();
    const payload = {
      toolUseId: 'x',
      name: 'Shell',
      isError: false,
      exitCode: 0,
      result: 'detailed \u0000\u0000\u0004 auto',
      nested: { 'k\u0000ey': ['\u0000', 1, null, true, { deep: 'ok' }] },
    };
    const result = await appendEvent({ type: 'session.tool.completed', actor: 'agent', agentName: 'engineer', userId: stand.userId, threadId: childId, payload });

    assert.ok(result.written);

    const expected = {
      toolUseId: 'x',
      name: 'Shell',
      isError: false,
      exitCode: 0,
      result: 'detailed \uFFFD\uFFFD\u0004 auto',
      nested: { 'k\uFFFDey': ['\uFFFD', 1, null, true, { deep: 'ok' }] },
    };
    const row = await prisma.event.findUniqueOrThrow({ where: { seq: result.event.seq } });

    assert.deepEqual(row.payload, expected);
    assert.deepEqual(result.event.payload, expected);
    // The caller's object is not rewritten under it.
    assert.equal(payload.result, 'detailed \u0000\u0000\u0004 auto');
  });

  test('a terminal whose summary carries U+0000 closes the thread, and the projection row holds the stored text', async () => {
    const childId = await startChild();
    const result = await appendEvent({
      type: 'thread.completed',
      actor: 'agent',
      agentName: 'engineer',
      userId: stand.userId,
      threadId: childId,
      targetThreadId: stand.mainThreadId,
      payload: { title: 'Done\u0000', description: 'd', summary: { text: 'sum\u0000mary' } },
    });

    assert.ok(result.written);

    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: childId } });

    assert.equal(thread.status, 'completed');
    assert.equal(thread.title, 'Done\uFFFD');
    assert.deepEqual(thread.summary, { text: 'sum\uFFFDmary' });
  });
});
