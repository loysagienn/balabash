// The CDP endpoint of one session: a loopback WebSocket a Playwright client
// connects to with connectOverCDP, backed by the session link of a user's
// browser through the model (cdp-model.ts).
//
// One endpoint — one session — one client. The path is a random id and the
// port is bound to loopback: knowing the address is the right to use it,
// as with Playwright's own relay. The endpoint lives as long as the session
// link: either side going away closes the other. Parking the session
// (hub.ts) is the one end that is not the session's: the endpoint goes, the
// session stays with the extension to come back behind a new endpoint.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createCdpModel } from './cdp-model.ts';
import type { CdpMessage } from './cdp-model.ts';
import type { ExtensionSession, ParkedSession } from './hub.ts';

export type CdpRelay = {
  // ws://127.0.0.1:<port>/cdp/<id> — for chromium.connectOverCDP.
  endpoint: string;
  // The tabs of the session the client is attached to, in the order it
  // numbers them.
  tabIds(): number[];
  // Parks the session and closes the endpoint. The client is not told of
  // the tabs being let go: its connection simply ends.
  park(): Promise<ParkedSession>;
  close(): Promise<void>;
};

export async function startCdpRelay(session: ExtensionSession): Promise<CdpRelay> {
  const path = `/cdp/${randomUUID()}`;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path, maxPayload: 256 * 1024 * 1024 });
  const model = createCdpModel((method, params) => session.send(method, params));
  let client: WebSocket | null = null;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const close = async () => {
    if (closed) {
      return;
    }

    closed = true;
    client?.close(1000, 'The session ended');
    // Nothing to do when the session is what went away.
    session.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };

  session.onEvent = (method, params) => model.handleExtensionEvent(method, params);
  void session.ended.then(close);

  server.on('connection', socket => {
    if (client) {
      socket.close(1000, 'Another client is connected');

      return;
    }

    client = socket;
    model.setClient(message => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });

    socket.on('message', data => {
      let message: CdpMessage | null;

      try {
        message = JSON.parse(String(data)) as CdpMessage | null;
      } catch {
        return;
      }

      // JSON, but no command: `null`, a number, a list.
      if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
        return;
      }

      const { id, sessionId, method, params } = message;

      model.handleCommand(method, params, sessionId).then(
        result => socket.send(JSON.stringify({ id, sessionId, result: result ?? {} })),
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);

          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ id, sessionId, error: { message: text } }));
          }
        },
      );
    });

    // The client is the session's reason to exist.
    socket.on('close', () => void close());
    socket.on('error', error => console.warn('[browser-link] CDP client error:', error.message));
  });

  const park = async (): Promise<ParkedSession> => {
    model.setClient(null);

    // A refusal has ended the session, and the endpoint with it.
    const parked = await session.park();

    closed = true;
    client?.close(1000, 'The session is parked');
    await new Promise<void>(resolve => server.close(() => resolve()));

    return parked;
  };

  return { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, tabIds: model.tabIds, park, close };
}
