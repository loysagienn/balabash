// What a test plays the extension with: a WebSocket client that dials a
// link the way the extension does — the console host and the extension's
// origin in the request — and keeps what the server said.

import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { CONTROL_PATH, EXTENSION_ID, PROTOCOL_VERSION } from './protocol.ts';
import type { Frame, HelloParams } from './protocol.ts';

export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

export type TestLink = {
  send(frame: Frame): void;
  // The next frame of the server that is not a `pong`.
  next(): Promise<Frame>;
  // How the link ended.
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
};

// Resolves with the open link; rejects with `HTTP <status>` when the server
// refused the upgrade.
export function dial(port: number, options: { host: string; path?: string; origin?: string | null }): Promise<TestLink> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? CONTROL_PATH}`, {
      headers: { host: options.host },
      ...(options.origin === null ? {} : { origin: options.origin ?? EXTENSION_ORIGIN }),
    });
    const frames: Frame[] = [];
    const waiting: ((frame: Frame) => void)[] = [];
    const closed = new Promise<{ code: number; reason: string }>(settle => {
      socket.on('close', (code, reason) => settle({ code, reason: reason.toString() }));
    });

    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as Frame;

      if (frame.method === 'pong') {
        return;
      }

      const taker = waiting.shift();

      if (taker) {
        taker(frame);
      } else {
        frames.push(frame);
      }
    });
    socket.on('unexpected-response', (_request, response: IncomingMessage) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.on('error', reject);
    socket.on('open', () =>
      resolve({
        send: frame => socket.send(JSON.stringify(frame)),
        next: () => {
          const frame = frames.shift();

          return frame ? Promise.resolve(frame) : new Promise<Frame>(take => waiting.push(take));
        },
        closed,
        close: () => socket.close(),
      }),
    );
  });
}

// A `hello` of this wire's version.
export function hello(identity: { secret: string } | { pairingCode: string; previousSecret?: string }, extensionVersion = '0.2.0'): Frame {
  const params: HelloParams = { protocol: PROTOCOL_VERSION, extensionVersion, ...identity };

  return { method: 'hello', params };
}
