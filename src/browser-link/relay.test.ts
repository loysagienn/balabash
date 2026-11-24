// The CDP endpoint of a session (relay.ts): what a client that sends
// something else than a command does to it — nothing.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { ExtensionSession } from './hub.ts';
import { startCdpRelay } from './relay.ts';

// A session nobody is behind: it never ends by itself.
function idleSession(): ExtensionSession {
  let end!: (value: { end: 'closed'; detail: string }) => void;
  const ended = new Promise<{ end: 'closed'; detail: string }>(resolve => {
    end = resolve;
  });

  return {
    id: 1,
    send: async () => ({}),
    onEvent: null,
    onNotice: null,
    claimTab: async () => {},
    ended,
    close: () => end({ end: 'closed', detail: '' }),
    park: async () => {
      throw new Error('not parked in this test');
    },
  };
}

describe('the CDP endpoint of a session', () => {
  test('passes over a frame that is JSON but no command, and answers the command behind it', async () => {
    const relay = await startCdpRelay(idleSession());
    const client = new WebSocket(relay.endpoint);
    const answers: unknown[] = [];

    client.on('message', data => answers.push(JSON.parse(String(data))));
    await new Promise(resolve => client.once('open', resolve));

    for (const frame of ['null', '5', '"text"', '[]', '{}', '{"method":7}', 'not json']) {
      client.send(frame);
    }

    client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));

    for (let waited = 0; answers.length === 0 && waited < 100; waited++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(answers.length, 1);
    assert.equal((answers[0] as { id: number; result: { product: string } }).result.product, 'Chrome/Extension-Bridge');
    client.close();
    await relay.close();
  });
});
