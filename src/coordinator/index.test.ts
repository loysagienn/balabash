// The coordinator run over the stand (src/test-support/stand.ts): the course
// of the main thread is journaled as session.state — `run` in the log before
// the model's first request of a turn, `wait` once the loop is done, by the
// coordinator as the thread's agent; a failed turn ends in `wait` after its
// system.exception; a loop that ran no turn writes nothing once the state is
// known. A lost write (the database away at that moment) is forgotten and
// written again — at the next wake, or by the run's own retry without one. A
// `run` left behind by a dead process is settled by the boot sweep
// (settleMainThreadStates), not by a wake. The model is a scripted client
// (the seam of createCoordinatorRun), the function definitions are empty —
// no tool server is connected.
//
// Cold against warm: the prompt builder's memory is the process's
// (resetPromptState stands for a restart) — on cold memory the first wake
// re-renders the whole transcript and is a turn; on warm memory the same
// wake renders to nothing and is none.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'openai/resources/responses/responses';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { TurnClient } from '../harness/openai/turn.ts';
import type { AppendInput } from '../core/envelope.ts';
import type { Event } from '../core/contract.ts';
import type { CoordinatorRun } from './index.ts';

type Logged = { type: string; actor: string; agentName: string | null; targetThreadId: string | null; payload: Record<string, unknown> };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let createCoordinatorRun: typeof import('./index.ts')['createCoordinatorRun'];
let settleMainThreadStates: typeof import('./index.ts')['settleMainThreadStates'];
let createJournalWriter: typeof import('../harness/session-journal.ts')['createJournalWriter'];
let resetPromptState: typeof import('../harness/openai/prompt-builder.ts')['resetPromptState'];
// The first wake — a wake is only a signal, the turn reads the log.
let first: Event;

before(async () => {
  stand = await startStand();
  // The coordinator model is the config's; the stand strips the OpenAI
  // variables.
  process.env.MAIN_OPENAI_MODEL = 'gpt-test-model';
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('../core/append.ts'));
  ({ createCoordinatorRun, settleMainThreadStates } = await import('./index.ts'));
  ({ createJournalWriter } = await import('../harness/session-journal.ts'));
  ({ resetPromptState } = await import('../harness/openai/prompt-builder.ts'));
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

// What a process that died mid-turn leaves behind: the coordinator's `run`
// as the newest state of the main thread.
async function leftInRun() {
  const result = await appendEvent({
    type: 'session.state',
    actor: 'agent',
    agentName: 'coordinator',
    userId: stand.userId,
    threadId: stand.mainThreadId,
    payload: { state: 'run' },
  });

  assert.ok(result.written);
}

// Waits for the log past `after` to hold `type` (the last thing the loop
// writes is its `wait`).
async function settled(after: bigint, type = 'session.state:wait'): Promise<Logged[]> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const events = await logged(after);

    if (types(events).includes(type)) {
      return events;
    }

    if (Date.now() > deadline) {
      assert.fail(`the loop did not settle: ${types(events).join(', ')}`);
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

// The real writer over an append that loses exactly the session.state
// writes named by `lose` — the database away for that write alone.
function flakyJournal() {
  const lost: string[] = [];
  let lose: string | null = null;
  const journal = createJournalWriter({
    append: async (input: AppendInput) => {
      if (input.type === 'session.state' && (input.payload as { state: string }).state === lose) {
        lose = null;
        lost.push((input.payload as { state: string }).state);
        throw new Error('db down');
      }

      return appendEvent(input);
    },
  });

  return { journal, lost, loseNext: (state: string) => (lose = state) };
}

function types(events: Logged[]): string[] {
  return events.map(event => (event.type === 'session.state' ? `session.state:${event.payload.state}` : event.type));
}

describe('the boot sweep over a `run` a dead process left behind', () => {
  test('a main thread without a session state is left alone', async () => {
    const from = await headSeq();

    assert.equal(await settleMainThreadStates(), 0);
    assert.deepEqual(types(await logged(from)), []);
  });

  test('the newest state `run` with no new event to route is settled to `wait` by the coordinator; the next sweep finds nothing', async () => {
    await leftInRun();

    const from = await headSeq();

    assert.equal(await settleMainThreadStates(), 1);

    const events = await logged(from);

    assert.deepEqual(types(events), ['session.state:wait']);
    assert.deepEqual({ actor: events[0]!.actor, agentName: events[0]!.agentName, targetThreadId: events[0]!.targetThreadId }, { actor: 'agent', agentName: 'coordinator', targetThreadId: null });

    assert.equal(await settleMainThreadStates(), 0);
    assert.deepEqual(types(await logged(from)), ['session.state:wait']);
  });

  test('a lost write settles nothing and does not fail the boot', async () => {
    await leftInRun();

    const flaky = flakyJournal();
    const from = await headSeq();

    flaky.loseNext('wait');

    assert.equal(await settleMainThreadStates({ journal: flaky.journal }), 0);
    assert.deepEqual(flaky.lost, ['wait']);
    assert.deepEqual(types(await logged(from)), []);

    // Settled for the tests below.
    assert.equal(await settleMainThreadStates(), 1);
  });
});

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

describe('a fresh run on warm memory', () => {
  test('knows no state: its first loop writes `wait` even without a turn', async () => {
    const model = scriptedClient();
    const fresh = createCoordinatorRun({ threadId: stand.mainThreadId, userId: stand.userId }, { client: model.client, functionDefinitions: async () => [] });
    const from = await headSeq();

    // The prompt builder's memory is the process's, warm from the turns
    // above: nothing new to render, no turn — the run writes the state it
    // does not know the log to hold.
    fresh.accept(first);

    const events = await settled(from);

    assert.deepEqual(types(events), ['session.state:wait']);
    assert.deepEqual(model.seen, []);
  });
});

describe('a fresh run on cold memory — a new process', () => {
  test('re-renders the transcript: the first wake is a turn, `run` then `wait`', async () => {
    const model = scriptedClient();
    const fresh = createCoordinatorRun({ threadId: stand.mainThreadId, userId: stand.userId }, { client: model.client, functionDefinitions: async () => [] });
    const from = await headSeq();

    // A restart drops the builder's memory of the thread — the same wake
    // that was nothing on warm memory finds the whole transcript new.
    resetPromptState(stand.mainThreadId);
    fresh.accept(first);

    const events = await settled(from);

    assert.deepEqual(types(events), ['session.state:run', 'session.state:wait']);
    assert.deepEqual(model.seen, ['run']);
  });
});

describe('a lost state write', () => {
  test('a lost `wait` is written at the next wake, with no turn', async () => {
    const model = scriptedClient();
    const flaky = flakyJournal();
    // The retry is far away: the wake is what recovers here.
    const run = createCoordinatorRun(
      { threadId: stand.mainThreadId, userId: stand.userId },
      { client: model.client, functionDefinitions: async () => [], journal: flaky.journal, stateRetryMs: 60_000 },
    );
    const from = await headSeq();

    flaky.loseNext('wait');
    run.accept(await said('lose the wait'));

    // The turn's `run` landed, its `wait` did not: the log reads `run`.
    await settled(from, 'session.state:run');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(flaky.lost, ['wait']);
    assert.deepEqual(types(await logged(from)), ['user.message', 'session.state:run']);

    // The same wake again — nothing new to render, no turn; the state the
    // run does not know the log to hold is written now.
    run.accept(first);

    assert.deepEqual(types(await settled(from)), ['user.message', 'session.state:run', 'session.state:wait']);
    assert.deepEqual(model.seen, ['run']);
  });

  test('a lost `wait` is written again by the run itself when no wake comes', async () => {
    const model = scriptedClient();
    const flaky = flakyJournal();
    const run = createCoordinatorRun(
      { threadId: stand.mainThreadId, userId: stand.userId },
      { client: model.client, functionDefinitions: async () => [], journal: flaky.journal, stateRetryMs: 50 },
    );
    const from = await headSeq();

    flaky.loseNext('wait');
    run.accept(await said('lose the wait, then wait'));

    assert.deepEqual(types(await settled(from)), ['user.message', 'session.state:run', 'session.state:wait']);
    assert.deepEqual(flaky.lost, ['wait']);
    assert.deepEqual(model.seen, ['run']);
  });

  test('a lost `run` does not stop the turn; the loop still ends in `wait`', async () => {
    const model = scriptedClient();
    const flaky = flakyJournal();
    const run = createCoordinatorRun(
      { threadId: stand.mainThreadId, userId: stand.userId },
      { client: model.client, functionDefinitions: async () => [], journal: flaky.journal, stateRetryMs: 60_000 },
    );
    const from = await headSeq();

    flaky.loseNext('run');
    run.accept(await said('lose the run'));

    // The model is asked over a log that still reads the previous `wait`.
    assert.deepEqual(types(await settled(from)), ['user.message', 'session.state:wait']);
    assert.deepEqual(flaky.lost, ['run']);
    assert.deepEqual(model.seen, ['wait']);
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
