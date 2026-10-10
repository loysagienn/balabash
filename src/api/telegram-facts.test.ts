// The Telegram enrichments over a fake Bot API: a slow call is abandoned
// at the deadline and the facts answer without it, a failure is null and
// asked again after its period, a success is kept, calls in flight are
// shared. No network, no token.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTelegramFacts } from './telegram-facts.ts';
import type { BotApiClient, BoundGroup } from './telegram-facts.ts';

const GROUP: BoundGroup = { chatId: -1003986621992n, updatedAt: new Date('2026-08-06T22:44:25.685Z') };

type Script = {
  getChat?: (signal?: AbortSignal) => Promise<{ title?: string }>;
  getMe?: (signal?: AbortSignal) => Promise<{ username?: string }>;
};

// A fake Bot API that counts its calls and answers by the script of the
// moment; `never` hangs until aborted (the way a stalled connection does).
function fakeClient(script: Script) {
  const calls = { getChat: 0, getMe: 0, aborted: 0 };
  const client: BotApiClient = {
    getChat: (_chatId, signal) => {
      calls.getChat += 1;

      return (script.getChat ?? never)(signal);
    },
    getMe: signal => {
      calls.getMe += 1;

      return (script.getMe ?? never)(signal);
    },
  };

  function never<T>(signal?: AbortSignal): Promise<T> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        calls.aborted += 1;
        reject(new Error('aborted'));
      });
    });
  }

  return { client, calls, script };
}

function facts(fake: ReturnType<typeof fakeClient> | null, group: BoundGroup | null, extra: { now?: () => number; timeoutMs?: number } = {}) {
  return createTelegramFacts({
    client: () => fake?.client ?? null,
    readGroup: () => Promise.resolve(group),
    timeoutMs: extra.timeoutMs ?? 20,
    now: extra.now,
  });
}

describe('telegram facts over the Bot API', () => {
  it('answers the local facts without the channel: nothing is asked', async () => {
    const telegram = facts(null, GROUP);

    assert.deepEqual(await telegram.view('u1'), { enabled: false, botUsername: null, group: { chatId: GROUP.chatId, title: null, linkedAt: GROUP.updatedAt } });
    assert.equal(await telegram.groupTitle('u1'), null);
    assert.equal(await telegram.botUsername(), null);
  });

  it('abandons a call that outlives the deadline, aborts it and answers with null', async () => {
    const fake = fakeClient({});
    const telegram = facts(fake, GROUP, { timeoutMs: 20 });
    const started = Date.now();
    const view = await telegram.view('u1');

    assert.ok(Date.now() - started < 1000, 'the view does not wait for the Bot API');
    assert.deepEqual(view, { enabled: true, botUsername: null, group: { chatId: GROUP.chatId, title: null, linkedAt: GROUP.updatedAt } });
    assert.deepEqual(fake.calls, { getChat: 1, getMe: 1, aborted: 2 });
  });

  it('ends the wait at the deadline even for a client that ignores the signal', async () => {
    const fake = fakeClient({ getMe: () => new Promise(() => undefined), getChat: () => new Promise(() => undefined) });
    const telegram = facts(fake, GROUP, { timeoutMs: 20 });

    assert.equal((await telegram.view('u1')).botUsername, null);
  });

  it('reads the title and the username, keeps them, and shares a call in flight', async () => {
    const fake = fakeClient({ getChat: () => Promise.resolve({ title: 'Home' }), getMe: () => Promise.resolve({ username: 'balabash_bot' }) });
    const telegram = facts(fake, GROUP);
    const [a, b] = await Promise.all([telegram.view('u1'), telegram.view('u1')]);

    assert.deepEqual(a, { enabled: true, botUsername: 'balabash_bot', group: { chatId: GROUP.chatId, title: 'Home', linkedAt: GROUP.updatedAt } });
    assert.deepEqual(b, a);
    assert.deepEqual(fake.calls, { getChat: 1, getMe: 1, aborted: 0 });

    // Kept: a third read, and the title through groupTitle, ask nothing.
    assert.equal(await telegram.groupTitle('u1'), 'Home');
    assert.equal((await telegram.view('u1')).botUsername, 'balabash_bot');
    assert.deepEqual(fake.calls, { getChat: 1, getMe: 1, aborted: 0 });
  });

  it('asks the username again after a failure once its period passed, and keeps a success for good', async () => {
    let clock = 1_000_000;
    const fake = fakeClient({ getMe: () => Promise.reject(new Error('502')) });
    const telegram = facts(fake, null, { now: () => clock });

    assert.equal(await telegram.botUsername(), null);
    assert.equal(await telegram.botUsername(), null);
    assert.equal(fake.calls.getMe, 1, 'a fresh failure is not asked again at once');

    clock += 60_000;
    fake.script.getMe = () => Promise.resolve({ username: 'balabash_bot' });
    assert.equal(await telegram.botUsername(), 'balabash_bot');
    assert.equal(fake.calls.getMe, 2);

    clock += 24 * 3_600_000;
    assert.equal(await telegram.botUsername(), 'balabash_bot');
    assert.equal(fake.calls.getMe, 2, 'a known username serves the process');
  });

  it('keeps a title — or its failure — for ten minutes, then asks again', async () => {
    let clock = 1_000_000;
    const fake = fakeClient({ getChat: () => Promise.reject(new Error('400: chat not found')), getMe: () => Promise.resolve({}) });
    const telegram = facts(fake, GROUP, { now: () => clock });

    assert.equal(await telegram.groupTitle('u1'), null);
    assert.equal(await telegram.groupTitle('u1'), null);
    assert.equal(fake.calls.getChat, 1);

    clock += 10 * 60_000;
    fake.script.getChat = () => Promise.resolve({ title: 'Home' });
    assert.equal(await telegram.groupTitle('u1'), 'Home');
    assert.equal(fake.calls.getChat, 2);

    clock += 9 * 60_000;
    assert.equal(await telegram.groupTitle('u1'), 'Home');
    assert.equal(fake.calls.getChat, 2);
  });

  it('is null without a group and asks nothing for it', async () => {
    const fake = fakeClient({ getMe: () => Promise.resolve({ username: 'balabash_bot' }) });
    const telegram = facts(fake, null);

    assert.equal(await telegram.groupTitle('u1'), null);
    assert.deepEqual(await telegram.view('u1'), { enabled: true, botUsername: 'balabash_bot', group: null });
    assert.equal(fake.calls.getChat, 0);
  });
});
