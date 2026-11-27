// The pace of Bot API calls: one chat's calls go in order and within its
// window, a 429 is waited out and the call repeated, a wait beyond the
// ceiling is given up. Time is a virtual clock: a sleep ends only when the
// test's clock is moved to it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { Api, GrammyError, InputFile } from 'grammy';
import { createTelegramLimiter } from './limiter.ts';
import type { TelegramLimiterOptions } from './limiter.ts';

type Response = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };
type Sent = { at: number; method: string; chat: unknown; tag: unknown };

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function stand(options: TelegramLimiterOptions = {}, answer: (sent: Sent, index: number) => Response | Promise<Response> = () => ({ ok: true, result: true })) {
  let time = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const sent: Sent[] = [];
  const logs: string[] = [];

  const { transformer } = createTelegramLimiter({
    now: () => time,
    sleep: ms => new Promise<void>(resolve => timers.push({ at: time + ms, resolve })),
    log: message => logs.push(message),
    ...options,
  });

  const prev = async (method: string, payload: { chat_id?: unknown; tag?: unknown }) => {
    const record = { at: time, method, chat: payload.chat_id, tag: payload.tag };

    sent.push(record);

    return answer(record, sent.length - 1);
  };

  const call = (method: string, payload: object, signal?: AbortSignal) =>
    (transformer as unknown as (prev: unknown, method: string, payload: object, signal?: AbortSignal) => Promise<Response>)(
      prev,
      method,
      payload,
      signal,
    );

  // Moves the clock from sleep to sleep until the promise settles.
  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    let settled = false;

    promise.then(
      () => (settled = true),
      () => (settled = true),
    );

    for (;;) {
      await tick();

      if (settled) {
        return promise;
      }

      timers.sort((a, b) => a.at - b.at);

      const next = timers.shift();

      assert.ok(next, 'the call waits for nothing and does not settle');
      time = Math.max(time, next.at);
      next.resolve();
    }
  };

  return { call, settle, sent, logs, advance: (ms: number) => (time += ms), time: () => time };
}

const tooMany = (retryAfter?: number): Response => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${retryAfter}`,
  ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
});

describe('telegram limiter', () => {
  it('lets a chat’s calls through at once below the limit, in the order they were made', async () => {
    const { call, settle, sent } = stand();

    await settle(Promise.all(Array.from({ length: 18 }, (_, tag) => call('sendRichMessage', { chat_id: -1, tag }))));

    assert.deepEqual(sent.map(item => item.tag), Array.from({ length: 18 }, (_, tag) => tag));
    assert.ok(sent.every(item => item.at === 0));
  });

  it('holds the calls over a chat’s limit until the window has room', async () => {
    const { call, settle, sent, advance, logs } = stand({ perChatLimit: 3, perChatWindowMs: 60_000 });

    await settle(call('sendRichMessage', { chat_id: -1, tag: 0 }));
    advance(10_000);
    await settle(Promise.all([1, 2, 3, 4].map(tag => call('sendDocument', { chat_id: -1, tag }))));

    // Two more fit the window; the fourth waits for the first to leave it,
    // the fifth for the second.
    assert.deepEqual(sent.map(item => [item.tag, item.at]), [[0, 0], [1, 10_000], [2, 10_000], [3, 60_000], [4, 70_000]]);
    assert.deepEqual(logs, [
      '[telegram-limiter] sendDocument to chat -1 waits 50s for the rate limit',
      '[telegram-limiter] sendDocument to chat -1 waits 10s for the rate limit',
    ]);
  });

  it('counts every call addressed to the chat, whatever the method and the topic', async () => {
    const { call, settle, sent } = stand({ perChatLimit: 2 });

    await settle(
      Promise.all([
        call('createForumTopic', { chat_id: -1, tag: 0 }),
        call('sendRichMessage', { chat_id: -1, message_thread_id: 7, tag: 1 }),
        call('closeForumTopic', { chat_id: -1, message_thread_id: 7, tag: 2 }),
      ]),
    );

    assert.deepEqual(sent.map(item => item.at), [0, 0, 60_000]);
  });

  it('does not make one chat wait for another’s window', async () => {
    const { call, settle, sent } = stand({ perChatLimit: 1 });

    const first = call('sendRichMessage', { chat_id: -1, tag: 'a1' });
    const held = call('sendRichMessage', { chat_id: -1, tag: 'a2' });
    const other = call('sendRichMessage', { chat_id: -2, tag: 'b1' });

    await settle(Promise.all([first, other]));
    assert.deepEqual(sent.map(item => item.tag), ['a1', 'b1']);

    await settle(held);
    assert.deepEqual(sent.map(item => [item.tag, item.at]), [['a1', 0], ['b1', 0], ['a2', 60_000]]);
  });

  it('keeps the whole bot under its own limit per second', async () => {
    const { call, settle, sent } = stand({ globalLimit: 2 });

    await settle(Promise.all([1, 2, 3, 4, 5].map(chat => call('sendMessage', { chat_id: chat }))));

    assert.deepEqual(sent.map(item => item.at), [0, 0, 1000, 1000, 2000]);
  });

  it('waits out a 429 and repeats the same call before the chat’s next ones', async () => {
    const { call, settle, sent, logs } = stand({}, (item, index) => (index === 1 ? tooMany(25) : { ok: true, result: item.tag }));

    const results = await settle(
      Promise.all([
        call('sendRichMessage', { chat_id: -1, tag: 'one' }),
        call('sendRichMessage', { chat_id: -1, tag: 'two' }),
        call('sendDocument', { chat_id: -1, tag: 'three' }),
      ]),
    );

    assert.deepEqual(results, [{ ok: true, result: 'one' }, { ok: true, result: 'two' }, { ok: true, result: 'three' }]);
    // retry_after and the margin of a second.
    assert.deepEqual(sent.map(item => [item.tag, item.at]), [['one', 0], ['two', 0], ['two', 26_000], ['three', 26_000]]);
    assert.deepEqual(logs, [
      '[telegram-limiter] sendRichMessage to chat -1 refused with 429 (refusal 1): repeating in 25s',
      '[telegram-limiter] sendRichMessage to chat -1 waits 26s for the rate limit',
    ]);
  });

  it('a 429 of one chat does not pause another', async () => {
    const { call, settle, sent } = stand({}, (item, index) => (index === 0 ? tooMany(30) : { ok: true, result: true }));

    const refused = call('sendRichMessage', { chat_id: -1, tag: 'a' });

    await settle(call('sendRichMessage', { chat_id: -2, tag: 'b' }));
    assert.deepEqual(sent.map(item => [item.tag, item.at]), [['a', 0], ['b', 0]]);

    await settle(refused);
    assert.deepEqual(sent.at(-1), { at: 31_000, method: 'sendRichMessage', chat: -1, tag: 'a' });
  });

  it('a 429 of a call that names no chat pauses the whole bot', async () => {
    const { call, settle, sent } = stand({}, (item, index) => (index === 0 ? tooMany(5) : { ok: true, result: true }));

    const refused = call('getFile', { file_id: 'x' });
    const message = call('sendRichMessage', { chat_id: -1 });

    await settle(Promise.all([refused, message]));

    assert.deepEqual(sent.map(item => [item.method, item.at]), [['getFile', 0], ['sendRichMessage', 0], ['getFile', 6000]]);

    await settle(call('sendRichMessage', { chat_id: -1 }));
    assert.equal(sent.at(-1)?.at, 6000);
  });

  it('gives up a wait beyond the ceiling: the 429 goes to the caller at once', async () => {
    const { call, settle, sent, logs } = stand({ maxRetryAfterSeconds: 300 }, () => tooMany(301));

    const response = await settle(call('sendRichMessage', { chat_id: -1 }));

    assert.deepEqual(response, tooMany(301));
    assert.equal(sent.length, 1);
    assert.deepEqual(logs, ['[telegram-limiter] sendRichMessage to chat -1 refused with 429 (retry after 301s, refusal 1): giving up']);
  });

  it('gives up after the allowed number of repeats', async () => {
    const { call, settle, sent } = stand({ maxRetries: 3 }, () => tooMany(10));

    const response = await settle(call('sendRichMessage', { chat_id: -1 }));

    assert.deepEqual(response, tooMany(10));
    assert.deepEqual(sent.map(item => item.at), [0, 11_000, 22_000, 33_000]);
  });

  it('returns a 429 without retry_after and any other refusal as they are', async () => {
    const refusal: Response = { ok: false, error_code: 400, description: 'Bad Request: chat not found' };
    const bare = stand({}, () => tooMany());
    const other = stand({}, () => refusal);

    assert.deepEqual(await bare.settle(bare.call('sendRichMessage', { chat_id: -1 })), tooMany());
    assert.equal(bare.sent.length, 1);
    assert.deepEqual(await other.settle(other.call('sendRichMessage', { chat_id: -1 })), refusal);
    assert.equal(other.sent.length, 1);
  });

  it('a call that throws does not stop the chat’s next ones', async () => {
    const { call, settle, sent } = stand({}, (item, index) => {
      if (index === 0) {
        throw new Error('network down');
      }

      return { ok: true, result: true };
    });

    const failed = call('sendRichMessage', { chat_id: -1, tag: 'a' });
    const next = call('sendRichMessage', { chat_id: -1, tag: 'b' });

    await assert.rejects(settle(failed), /network down/);
    assert.deepEqual(await settle(next), { ok: true, result: true });
    assert.deepEqual(sent.map(item => item.tag), ['a', 'b']);
  });

  it('a call abandoned by its caller does not sit out the pause', async () => {
    const controller = new AbortController();
    const { call, settle, sent, time } = stand({}, (item, index) => (index === 0 ? tooMany(120) : { ok: true, result: true }));

    const polling = call('getUpdates', {}, controller.signal);

    await tick();
    assert.equal(sent.length, 1);
    controller.abort();
    await settle(polling);

    // The repeat was made at once (the real call fails on its signal).
    assert.equal(sent.length, 2);
    assert.equal(time(), 0);
  });
});

// The transformer under a real grammY client: what grammY hands a
// transformer on a refusal, and what the caller gets in the end.
describe('telegram limiter under grammY', () => {
  const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  function client(answers: object[]) {
    const requests: string[] = [];
    let time = 0;

    const api = new Api('123:test', {
      fetch: (async (url: unknown, init?: { body?: AsyncIterable<Uint8Array> | string }) => {
        // The body is read to its end, as a server would: a file's stream is
        // consumed by the attempt that sent it.
        if (init?.body && typeof init.body !== 'string') {
          for await (const chunk of init.body) {
            void chunk;
          }
        }

        requests.push(String(url).split('/').at(-1)!);

        return json(answers[requests.length - 1] ?? { ok: true, result: { message_id: requests.length } });
      }) as never,
    });

    api.config.use(
      createTelegramLimiter({
        now: () => time,
        sleep: async ms => {
          time += ms;
        },
        log: () => {},
      }).transformer,
    );

    return { api, requests, time: () => time };
  }

  const refusal = (retryAfter: number) => ({
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  });

  it('a refused message is sent again after the pause and the caller gets the sent one', async () => {
    const { api, requests, time } = client([refusal(25), { ok: true, result: { message_id: 42 } }]);

    const sent = await api.sendRichMessage(-100, { markdown: 'hello' }, { message_thread_id: 7 });

    assert.equal(sent.message_id, 42);
    assert.deepEqual(requests, ['sendRichMessage', 'sendRichMessage']);
    assert.equal(time(), 26_000);
  });

  it('a refused upload opens the file again for the repeat', async () => {
    const { api, requests } = client([refusal(3)]);
    let opened = 0;

    const file = new InputFile(async () => {
      opened += 1;

      return Readable.from([Buffer.from('content')]);
    }, 'a.txt');

    const sent = await api.sendDocument(-100, file);

    assert.equal(sent.message_id, 2);
    assert.deepEqual(requests, ['sendDocument', 'sendDocument']);
    assert.equal(opened, 2);
  });

  it('a wait beyond the ceiling reaches the caller as the 429 it was', async () => {
    const { api, requests } = client([refusal(3600)]);

    await assert.rejects(api.sendRichMessage(-100, { markdown: 'hello' }), (error: unknown) => {
      assert.ok(error instanceof GrammyError);
      assert.equal(error.error_code, 429);
      assert.equal(error.parameters.retry_after, 3600);

      return true;
    });
    assert.deepEqual(requests, ['sendRichMessage']);
  });
});
