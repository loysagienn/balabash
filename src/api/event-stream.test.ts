// The SSE tail over a fake log: frames arrive in seq order with the seq as
// the id, a reconnect with Last-Event-ID catches up from the log, events
// of another workspace are filtered, installation-level ones pass.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import type { Event } from '../core/contract.ts';
import { createLiveHub } from '../core/live.ts';
import { parseJson } from '../utils/serialize-json.ts';
import { createEventStreamHandler } from './event-stream.ts';

const log: Event[] = [];
let server: ReturnType<Koa['listen']>;
let port: number;

function push(seq: number, userId: string | null, type = 'thread.progress'): Event {
  const event: Event = {
    seq: BigInt(seq),
    id: `e${seq}`,
    type,
    actor: 'agent',
    agentName: 'engineer',
    userId,
    threadId: userId ? 't' : null,
    targetThreadId: null,
    payload: { text: `event ${seq}` },
    schemaVersion: 1,
    createdAt: new Date(seq * 1000),
  };

  log.push(event);

  return event;
}

const hub = createLiveHub({
  readAfter: async (seq, limit) => log.filter(event => event.seq > seq).slice(0, limit),
  headSeq: async () => log[log.length - 1]?.seq ?? 0n,
  pollIntervalMs: 60_000,
});

type Frame = { id: string | null; data: Event | null; comment: string | null };

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(block => {
      const frame: Frame = { id: null, data: null, comment: null };

      for (const line of block.split('\n')) {
        if (line.startsWith(':')) {
          frame.comment = line.slice(1).trim();
        } else if (line.startsWith('id: ')) {
          frame.id = line.slice(4);
        } else if (line.startsWith('data: ')) {
          frame.data = parseJson(line.slice(6)) as Event;
        }
      }

      return frame;
    });
}

// Opens the stream, resolves with the parsed frames once `expectedEvents`
// data frames arrived (or on end), then destroys the connection.
function openStream(path: string, headers: Record<string, string>, expectedEvents: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, res => {
      let text = '';
      const finish = () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, frames: parseFrames(text) });
      };

      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;

        if (parseFrames(text).filter(frame => frame.data).length >= expectedEvents) {
          finish();
        }
      });
      res.on('end', finish);
    });

    req.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        reject(error);
      }
    });
    req.end();
  });
}

describe('GET /api/events/stream', () => {
  before(async () => {
    const app = new Koa();
    const handler = createEventStreamHandler({ hub, readAfter: async (seq, limit) => log.filter(event => event.seq > seq).slice(0, limit), heartbeatMs: 60_000, pageSize: 2 });

    app.use(async (ctx, next) => {
      ctx.state.userId = 'u1';
      await next();
    });
    app.use(async ctx => {
      if (ctx.path === '/api/events/stream') {
        await handler(ctx);
      } else {
        ctx.status = 404;
      }
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    push(1, 'u1');
    push(2, 'u1');
    push(3, 'other');
    push(4, null, 'system.restart.completed');
    push(5, 'u1');
  });

  after(async () => {
    hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('catches up from ?after= across pages, in order, filtered to the workspace', async () => {
    const { status, headers, frames } = await openStream('/api/events/stream?after=1', {}, 3);

    assert.equal(status, 200);
    assert.match(headers['content-type'] ?? '', /text\/event-stream/);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['x-accel-buffering'], 'no');
    assert.equal(frames[0]?.comment, 'connected');

    const data = frames.filter(frame => frame.data);

    assert.deepEqual(
      data.map(frame => [frame.id, frame.data!.seq, frame.data!.userId]),
      [
        ['2', 2n, 'u1'],
        ['4', 4n, null],
        ['5', 5n, 'u1'],
      ],
    );
    assert.deepEqual(data[0]!.data!.createdAt, new Date(2000));
  });

  test('Last-Event-ID wins over ?after= and the live tail follows the catch-up', async () => {
    const streamed = openStream('/api/events/stream?after=0', { 'last-event-id': '4' }, 3);

    // Let the catch-up reach the head, then grow the log.
    await new Promise(resolve => setTimeout(resolve, 50));
    push(6, 'u1');
    push(7, 'other');
    push(8, 'u1');
    hub.notify(8n);

    const { frames } = await streamed;
    const data = frames.filter(frame => frame.data);

    assert.deepEqual(
      data.map(frame => frame.id),
      ['5', '6', '8'],
    );
  });

  test('rejects a missing cursor', async () => {
    const { status } = await openStream('/api/events/stream', {}, 0);

    assert.equal(status, 400);
  });
});
