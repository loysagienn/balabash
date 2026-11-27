// The pace of the bot's calls to the Bot API: a transformer every call of the
// bot passes through (delivery, replies to commands, topic management).
//
// Telegram limits a bot per chat — about 20 messages a minute into one
// group, the rest answered with 429 and a `retry_after` — and overall (about
// 30 calls a second). The limits are not published exactly and a 429 is the
// only authority, so the limiter does two things:
//   - keeps ahead of the limit: the calls addressed to one chat go one at a
//     time, in the order they were made, and no more than `perChatLimit` of
//     them start within `perChatWindowMs`; the rest wait for the window.
//     Everything addressed to the chat counts, topic management included —
//     Telegram does not say what it counts, and the refusals seen on
//     2026-11-26 came after about 20 calls of all kinds;
//   - obeys a 429: the chat waits out `retry_after` and the same call is
//     repeated, so the message is late, not lost, and stays in its place.
//     A call that names no chat pauses the whole bot instead.
// A wait Telegram asks for beyond `maxRetryAfterSeconds`, or a call refused
// more than `maxRetries` times, is given up: the 429 goes to the caller as
// it did before, so nothing waits forever.
//
// The state lives in memory. A restart forgets the window; the first burst
// after it may meet a 429 and is then paced by `retry_after`.

import type { Transformer } from 'grammy';

export type TelegramLimiterOptions = {
  perChatLimit?: number;
  perChatWindowMs?: number;
  globalLimit?: number;
  globalWindowMs?: number;
  maxRetryAfterSeconds?: number;
  maxRetries?: number;
  // Added to `retry_after`: Telegram rounds the wait down to whole seconds.
  retryMarginMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

export type TelegramLimiter = {
  transformer: Transformer;
};

// One gate: the starts of the calls it let through within its window, and
// the moment a 429 closed it until.
type Gate = {
  starts: number[];
  pausedUntil: number;
};

type Lane = Gate & {
  // The end of the last call queued for the chat: the next one starts after.
  tail: Promise<void>;
  pending: number;
};

// What a wait needs of the caller's abort signal (grammY types it by its own
// shim, not by the platform's AbortSignal).
type Signal = {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
};

// A wait worth a line in the log; shorter ones are the ordinary pace.
const LOG_WAIT_FROM_MS = 1000;

function chatKeyOf(payload: unknown): string | null {
  const chatId = (payload as { chat_id?: unknown } | null | undefined)?.chat_id;

  return typeof chatId === 'number' || typeof chatId === 'string' ? String(chatId) : null;
}

export function createTelegramLimiter({
  perChatLimit = 18,
  perChatWindowMs = 60_000,
  globalLimit = 25,
  globalWindowMs = 1000,
  maxRetryAfterSeconds = 300,
  maxRetries = 3,
  retryMarginMs = 1000,
  now = Date.now,
  sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  log = message => console.warn(message),
}: TelegramLimiterOptions = {}): TelegramLimiter {
  const bot: Gate = { starts: [], pausedUntil: 0 };
  const lanes = new Map<string, Lane>();

  // When the gate lets the next call through: after its pause, and once the
  // window has room.
  const opensAt = (gate: Gate, limit: number, windowMs: number, at: number): number => {
    while (gate.starts.length && gate.starts[0]! + windowMs <= at) {
      gate.starts.shift();
    }

    return Math.max(gate.pausedUntil, gate.starts.length >= limit ? gate.starts[0]! + windowMs : 0);
  };

  const isSpent = (lane: Lane, at: number): boolean =>
    lane.pending === 0 && lane.pausedUntil <= at && (lane.starts.at(-1) ?? -Infinity) + perChatWindowMs <= at;

  const laneOf = (key: string): Lane => {
    let lane = lanes.get(key);

    if (!lane) {
      const at = now();

      // The chats the bot talked to long ago leave no state behind.
      for (const [otherKey, other] of lanes) {
        if (isSpent(other, at)) {
          lanes.delete(otherKey);
        }
      }

      lane = { starts: [], pausedUntil: 0, tail: Promise.resolve(), pending: 0 };
      lanes.set(key, lane);
    }

    return lane;
  };

  // A wait the caller's signal cuts short: a call abandoned by its caller
  // (the update polling at shutdown) must not hold it for the rest of a pause.
  const waitFor = (ms: number, signal: Signal | undefined): Promise<void> => {
    if (!signal) {
      return sleep(ms);
    }

    return new Promise(resolve => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };

      signal.addEventListener('abort', done, { once: true });
      void sleep(ms).then(done);
    });
  };

  // Waits until both gates are open and takes a place in their windows. The
  // gates are read again after every sleep: another chat may have used the
  // bot's window meanwhile, a 429 may have closed either. An aborted call
  // takes no place — the call itself fails on its signal.
  const takeTurn = async (
    lane: Lane | null,
    method: string,
    key: string | null,
    signal: Signal | undefined,
  ): Promise<void> => {
    let logged = false;

    for (;;) {
      if (signal?.aborted) {
        return;
      }

      const at = now();
      const until = Math.max(
        opensAt(bot, globalLimit, globalWindowMs, at),
        lane ? opensAt(lane, perChatLimit, perChatWindowMs, at) : 0,
      );

      if (until <= at) {
        bot.starts.push(at);
        lane?.starts.push(at);

        return;
      }

      if (!logged && until - at >= LOG_WAIT_FROM_MS) {
        logged = true;
        log(`[telegram-limiter] ${method}${key ? ` to chat ${key}` : ''} waits ${Math.ceil((until - at) / 1000)}s for the rate limit`);
      }

      await waitFor(until - at, signal);
    }
  };

  const transformer: Transformer = async (prev, method, payload, signal) => {
    const key = chatKeyOf(payload);
    const lane = key === null ? null : laneOf(key);

    const call = async () => {
      let refusals = 0;

      for (;;) {
        await takeTurn(lane, method, key, signal);

        const response = await prev(method, payload, signal);

        if (response.ok || response.error_code !== 429) {
          return response;
        }

        const retryAfter = response.parameters?.retry_after;

        refusals += 1;

        if (typeof retryAfter !== 'number' || retryAfter > maxRetryAfterSeconds || refusals > maxRetries) {
          log(
            `[telegram-limiter] ${method}${key ? ` to chat ${key}` : ''} refused with 429 ` +
              `(retry after ${retryAfter ?? 'unknown'}s, refusal ${refusals}): giving up`,
          );

          return response;
        }

        log(
          `[telegram-limiter] ${method}${key ? ` to chat ${key}` : ''} refused with 429 ` +
            `(refusal ${refusals}): repeating in ${retryAfter}s`,
        );

        const gate: Gate = lane ?? bot;

        gate.pausedUntil = Math.max(gate.pausedUntil, now() + retryAfter * 1000 + retryMarginMs);
      }
    };

    if (!lane) {
      return call();
    }

    lane.pending += 1;

    const run = lane.tail.then(call);

    lane.tail = run.then(
      () => {
        lane.pending -= 1;
      },
      () => {
        lane.pending -= 1;
      },
    );

    return run;
  };

  return { transformer };
}
