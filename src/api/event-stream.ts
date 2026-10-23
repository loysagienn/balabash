// GET /api/events/stream — the live tail of the workspace's event log as
// Server-Sent Events. The client names its cursor (?after=<seq>, or the
// Last-Event-ID header a browser sends on reconnect — it wins); the server
// first reads everything after it from the log, then hands over to the
// process-wide live hub (src/core/live.ts) — the log is the base, so a
// reconnect never leaves a gap. Events travel whole, through serialize-json,
// in seq order; a comment heartbeat keeps idle proxies from cutting the
// connection. Scoped to the session's workspace plus installation-level
// events (workspaceId null: restarts, exceptions outside a workspace).
//
// Beside the log, the stream carries the user's draft signals
// (src/drafts) as named frames — `event: draft`, data { threadId,
// revision } — without an id: they are not events of the log, the
// browser's Last-Event-ID stays the log's cursor, and a reconnect does not
// replay them (the console reads the draft itself after a reconnect).
// Ephemeral: sent the moment they arrive, before or after the catch-up.

import type { Context } from 'koa';
import type { Event } from '../core/contract.ts';
import type { LiveHub } from '../core/live.ts';
import type { DraftSignal, DraftSignals } from '../drafts/index.ts';
import type { DraftStreamFrame } from './contract.ts';
import { stringifyJson } from '../utils/serialize-json.ts';

export type EventStreamDeps = {
  hub: LiveHub;
  // Events strictly after seq, oldest first, at most limit (getEventsAfter).
  readAfter: (seq: bigint, limit: number) => Promise<Event[]>;
  // The draft signals of the users (src/drafts); none — no draft frames.
  drafts?: Pick<DraftSignals, 'subscribe'>;
  heartbeatMs?: number;
  pageSize?: number;
};

export const HEARTBEAT_MS = 25_000;

function parseSeq(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function sseFrame(event: Event): string {
  return `id: ${event.seq}\ndata: ${stringifyJson(event)}\n\n`;
}

export function draftFrame(signal: DraftSignal): string {
  const frame: DraftStreamFrame = { threadId: signal.threadId, revision: signal.revision };

  return `event: draft\ndata: ${stringifyJson(frame)}\n\n`;
}

// The handler assumes the session gate already ran (ctx.state.workspaceId,
// ctx.state.userId).
export function createEventStreamHandler({ hub, readAfter, drafts, heartbeatMs = HEARTBEAT_MS, pageSize = 500 }: EventStreamDeps) {
  return async (ctx: Context): Promise<void> => {
    const workspaceId = ctx.state.workspaceId as string;
    const userId = typeof ctx.state.userId === 'string' ? ctx.state.userId : null;
    const lastEventId = parseSeq(ctx.get('last-event-id') || undefined);
    const after = parseSeq(typeof ctx.query.after === 'string' ? ctx.query.after : undefined);
    const cursor = lastEventId ?? after;

    if (cursor === null) {
      ctx.status = 400;
      ctx.body = { error: { code: 'bad_request', message: 'after must be a decimal event seq (or send Last-Event-ID)' } };

      return;
    }

    const visible = (event: Event) => event.workspaceId === workspaceId || event.workspaceId === null;
    // Written straight to the response (ctx.respond = false): Koa's stream
    // pipeline would report every client disconnect as a premature close.
    const { res } = ctx;
    let sent = cursor;
    let closed = false;
    let live = false;
    const pending: Event[] = [];

    const send = (events: Event[]) => {
      for (const event of events) {
        if (event.seq <= sent) {
          continue;
        }

        sent = event.seq;

        if (visible(event)) {
          res.write(sseFrame(event));
        }
      }
    };

    // Subscribed before the catch-up read: whatever the hub dispatches
    // meanwhile waits in `pending` and is replayed (seq-deduplicated) once
    // the catch-up reaches the head.
    const unsubscribe = hub.subscribe(events => {
      if (closed) {
        return;
      }

      if (live) {
        send(events);
      } else {
        pending.push(...events);
      }
    });

    // The user's draft signals of this workspace, written as they come.
    const unsubscribeDrafts =
      drafts && userId !== null
        ? drafts.subscribe(userId, workspaceId, signal => {
            if (!closed) {
              res.write(draftFrame(signal));
            }
          })
        : () => {};

    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(': ping\n\n');
      }
    }, heartbeatMs);

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeDrafts();
      res.end();
    };

    res.once('close', close);

    ctx.respond = false;
    ctx.status = 200;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    // Catch-up from the log, page by page, then go live. Runs after the
    // handler returned — the response is already flowing.
    void (async () => {
      try {
        for (;;) {
          if (closed) {
            return;
          }

          const page = await readAfter(sent, pageSize);

          send(page);

          if (page.length < pageSize) {
            break;
          }
        }

        live = true;
        send(pending.splice(0));
      } catch (error) {
        console.error('[api] event stream catch-up failed:', error);
        close();
      }
    })();
  };
}
