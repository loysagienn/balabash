// The coordinator run over the stand (src/test-support/stand.ts): the course
// of the main thread is journaled as session.state — `run` in the log before
// the model's first request of a turn, `wait` once the loop is done, by the
// coordinator as the thread's agent; a failed turn ends in `wait` after its
// system.exception; a loop that ran no turn writes nothing once the state is
// known. The model is a scripted client (the seam of createCoordinatorRun),
// the function definitions are empty — no tool server is connected.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'openai/resources/responses/responses';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { TurnClient } from '../harness/openai/turn.ts';
import type { Event } from '../core/contract.ts';
import type { CoordinatorRun } from './index.ts';

type Logged = { type: string; actor: string; agentName: string | null; targetThreadId: string | null; payload: Record<string, unknown> };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let createCoordinatorRun: typeof import('./index.ts')['createCoordinatorRun'];
// The first wake — a wake is only a signal, the turn reads the log.
let first: Event;

before(async () => {
  stand = await startStand();
  // The coordinator model is the config's; the stand strips the OpenAI
  // variables.
  process.env.MAIN_OPENAI_MODEL = 'gpt-test-model';
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('../core/append.ts'));
  ({ createCoordinatorRun } = await import('./index.ts'));
});

after(async () => {
  delete process.env.MAIN_OPENAI_MODEL;
  await stand.stop();
});

// The main thread's log past `after`, oldest first.
async function logged(after: bigint): Promise<Logged[]> {
  const rows = await prisma.event.findMany({ where: { threadId: stand.mainThreadId, seq: { gt: after } }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ type: row.type, actor: row.actor, agentName: row.agentName, targetThreadId: row.targetThreadId, payload: row.payload as Record<string, unknown> }));
}

async function headSeq(): Promise<bigint> {
  const row = await prisma.event.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });

  return row?.seq ?? 0n;
}

// The newest session.state of the main thread, as the console's snapshot
// would read it.
async function stateInLog(): Promise<string | null> {
  const row = await prisma.event.findFirst({ where: { threadId: stand.mainThreadId, type: 'session.state' }, orderBy: { seq: 'desc' } });

  return row ? ((row.payload as { state: string }).state ?? null) : null;
}

async function said(text: string) {
  const result = await appendEvent({
    type: 'user.message',
    actor: 'user',
    userId: stand.userId,
    threadId: stand.mainThreadId,
    payload: { text, source: 'web', identity: { username: 'operator' } },
  });

  assert.ok(result.written);

  return result.event;
}

// Waits for the loop to settle: the `wait` after `after` is the last thing
// the loop writes.
async function settled(after: bigint): Promise<Logged[]> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const events = await logged(after);

    if (events.some(event => event.type === 'session.state' && event.payload.state === 'wait')) {
      return events;
    }

    if (Date.now() > deadline) {
      assert.fail(`the loop did not settle: ${events.map(event => event.type).join(', ')}`);
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// A model that ends every turn at once (do_nothing) and notes the state the
// log held when each request came in; `failing` makes it throw instead.
function scriptedClient() {
  const seen: Array<string | null> = [];
  let failing = false;
  let n = 0;

  const client: TurnClient = {
    responses: {
      create: async () => {
        seen.push(await stateInLog());

        if (failing) {
          throw new Error('the model is down');
        }

        n += 1;

        return {
          id: `resp-${n}`,
          output: [{ type: 'function_call', call_id: `call-${n}`, name: 'do_nothing', arguments: '{}' }],
        } as unknown as Response;
      },
    },
  };

  return { client, seen, fail: (value: boolean) => (failing = value) };
}

function types(events: Logged[]): string[] {
  return events.map(event => (event.type === 'session.state' ? `session.state:${event.payload.state}` : event.type));
}

describe('the course of the main thread', () => {
  const model = scriptedClient();
  let run: CoordinatorRun;

  before(() => {
    run = createCoordinatorRun({ threadId: stand.mainThreadId, userId: stand.userId }, { client: model.client, functionDefinitions: async () => [] });
  });

  test('a turn is `run` in the log before the model is asked and `wait` once the loop is done, by the coordinator', async () => {
    const from = await headSeq();

    first = await said('hello');
    run.accept(first);

    const events = await settled(from);

    assert.deepEqual(types(events), ['user.message', 'session.state:run', 'session.state:wait']);
    assert.deepEqual(model.seen, ['run']);

    for (const event of events.slice(1)) {
      assert.deepEqual({ actor: event.actor, agentName: event.agentName, targetThreadId: event.targetThreadId }, { actor: 'agent', agentName: 'coordinator', targetThreadId: null });
    }
  });

  test('the next turn writes `run` and `wait` again — each a change of state', async () => {
    const from = await headSeq();

    run.accept(await said('and again'));

    assert.deepEqual(types(await settled(from)), ['user.message', 'session.state:run', 'session.state:wait']);
    assert.deepEqual(model.seen, ['run', 'run']);
  });

  test('a wake with nothing new to render runs no turn and writes nothing once the state is known', async () => {
    const from = await headSeq();

    // The same wake again: the transcript holds nothing past the last turn.
    run.accept(first);

    await new Promise(resolve => setTimeout(resolve, 300));

    assert.deepEqual(types(await logged(from)), []);
    assert.deepEqual(model.seen, ['run', 'run']);
  });
});

describe('the first loop of a process', () => {
  test('settles the log to `wait` even when it ran no turn — a `run` a dead process left behind is answered', async () => {
    const model = scriptedClient();
    const fresh = createCoordinatorRun({ threadId: stand.mainThreadId, userId: stand.userId }, { client: model.client, functionDefinitions: async () => [] });
    const from = await headSeq();

    // The prompt builder's state is the thread's, warm from the turns above:
    // nothing new to render, no turn — the fresh run knows no state yet and
    // writes `wait`.
    fresh.accept(first);

    const events = await settled(from);

    assert.deepEqual(types(events), ['session.state:wait']);
    assert.deepEqual(model.seen, []);
  });
});

describe('a failed turn', () => {
  test('ends in `wait` after its system.exception', async () => {
    const model = scriptedClient();
    const run = createCoordinatorRun({ threadId: stand.mainThreadId, userId: stand.userId }, { client: model.client, functionDefinitions: async () => [] });
    const from = await headSeq();

    model.fail(true);
    run.accept(await said('once more'));

    const events = await settled(from);

    assert.deepEqual(types(events), ['user.message', 'session.state:run', 'system.exception', 'session.state:wait']);
    assert.equal(events[2]!.payload.scope, 'coordinator-turn');
    assert.deepEqual(model.seen, ['run']);
  });
});

