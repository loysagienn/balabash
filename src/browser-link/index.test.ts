// The right of a session to its browser (Hold in index.ts) through the
// forms a session takes — open, parked, on its way between the two: a
// withdrawal reaches it in every one of them. The hub's sessions are played
// by the test; the relay in front of them is the real one.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionSession, ParkedSession, SessionEnd } from './hub.ts';
import { BrowserAccessError, relaySession } from './index.ts';
import type { Hold } from './index.ts';

type Outcome = { end: SessionEnd; detail: string };

function gate() {
  let open!: () => void;
  const passed = new Promise<void>(resolve => {
    open = resolve;
  });

  return { open, passed };
}

// A session of the hub with what the hub does when it is parked and comes
// back; `parking` and `returning` hold the two steps until the test lets go.
function played() {
  const parking = gate();
  const returning = gate();
  const log: string[] = [];
  let settleParked!: (outcome: Outcome) => void;
  const parkedEnded = new Promise<Outcome>(resolve => {
    settleParked = resolve;
  });
  const session = (name: string): ExtensionSession => {
    let settle!: (outcome: Outcome) => void;
    let over = false;
    const ended = new Promise<Outcome>(resolve => {
      settle = resolve;
    });
    const made: ExtensionSession = {
      id: 1,
      send: async () => ({}),
      onEvent: null,
      onNotice: null,
      claimTab: async () => {},
      ended,
      close: (end = 'closed') => {
        if (!over) {
          over = true;
          log.push(`${name} closed as ${end}`);
          settle({ end, detail: '' });
        }
      },
      park: async () => {
        await parking.passed;
        // The hub closes the link of a session it parked — one that somebody closed already keeps its reason.
        made.close('closed');

        return parked;
      },
    };

    return made;
  };
  const parked: ParkedSession = {
    id: 1,
    ended: parkedEnded,
    resume: async () => {
      log.push('asked back');
      await returning.passed;

      return session('returned');
    },
    close: (end = 'closed') => {
      log.push(`parked closed as ${end}`);
      settleParked({ end, detail: '' });
    },
  };

  return { first: session('first'), parking, returning, log };
}

function hold(allowed = () => true) {
  const state = { forgotten: 0 };
  const made: Hold = {
    withdrawn: false,
    end: () => {},
    allowed: async () => allowed(),
    forget: () => {
      state.forgotten += 1;
    },
  };
  // What disabling the browser in the workspace of the session does.
  const withdraw = () => {
    made.withdrawn = true;
    made.end();
  };

  return { hold: made, state, withdraw };
}

const RESUME = { clientName: 'test', label: '', tabIds: [] };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe('a browser withdrawn from the workspace of a session', () => {
  test('ends the session that is open', async () => {
    const { first, log } = played();
    const { hold: held, state, withdraw } = hold();
    const relayed = await relaySession('b1', first, held);

    withdraw();
    assert.equal((await relayed.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as revoked'], 1]);
  });

  test('ends the session that is on its way into parking: what was parked is dropped', async () => {
    const { first, parking, log } = played();
    const { hold: held, state, withdraw } = hold();
    const relayed = await relaySession('b1', first, held);
    const parkingNow = relayed.park();

    await settle();
    withdraw();
    parking.open();

    const parked = await parkingNow;

    assert.equal((await parked.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as revoked', 'parked closed as revoked'], 1]);
  });

  test('ends the session that is parked', async () => {
    const { first, parking, log } = played();
    const { hold: held, state, withdraw } = hold();
    const relayed = await relaySession('b1', first, held);

    parking.open();

    const parked = await relayed.park();

    await settle();
    assert.equal(state.forgotten, 0, 'a parked session is held still');
    withdraw();
    assert.equal((await parked.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as closed', 'parked closed as revoked'], 1]);
  });

  test('ends the session that is on its way back, once it is back', async () => {
    const { first, parking, returning, log } = played();
    const { hold: held, state, withdraw } = hold();
    const relayed = await relaySession('b1', first, held);

    parking.open();

    const parked = await relayed.park();
    const coming = parked.resume(RESUME);

    coming.catch(() => {});
    await settle();
    withdraw();
    returning.open();
    await assert.rejects(coming, (error: unknown) => error instanceof BrowserAccessError && error.code === 'not_enabled');
    assert.equal((await parked.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as closed', 'asked back', 'returned closed as revoked'], 1]);
  });

  test('keeps a parked session from coming back when nobody was there to tell it: the workspace is asked again', async () => {
    let enabled = true;
    const { first, parking, log } = played();
    const { hold: held, state } = hold(() => enabled);
    const relayed = await relaySession('b1', first, held);

    parking.open();

    const parked = await relayed.park();

    enabled = false;
    await assert.rejects(parked.resume(RESUME), (error: unknown) => error instanceof BrowserAccessError && error.code === 'not_enabled');
    assert.equal((await parked.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as closed', 'parked closed as revoked'], 1], 'the extension was not asked for the session');
  });
});

describe('a session that came back', () => {
  test('is held by the same right: a withdrawal ends it, and only its end lets the right go', async () => {
    const { first, parking, returning, log } = played();
    const { hold: held, state, withdraw } = hold();
    const relayed = await relaySession('b1', first, held);

    parking.open();
    returning.open();

    const back = await (await relayed.park()).resume(RESUME);

    await settle();
    assert.equal(state.forgotten, 0);
    withdraw();
    assert.equal((await back.ended).end, 'revoked');
    await settle();
    assert.deepEqual([log, state.forgotten], [['first closed as closed', 'asked back', 'returned closed as revoked'], 1]);
  });
});
