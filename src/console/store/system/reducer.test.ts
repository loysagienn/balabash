// The system domain: the snapshot's log placed by seq, the tail's
// system.* events placed likewise, a held seq ignored, the newest KEEP
// kept, a completion moving the restarts stamp; and the restart in the
// way derived from the log.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventAction } from '../events.ts';
import { event, resetSeq, snapshot } from '../fixtures.ts';
import { snapshotLoadDone } from '../stream/actions.ts';
import { KEEP, initialSystem, systemReducer } from './reducer.ts';
import { pendingRestartOf } from './selectors.ts';

const requested = (seq: bigint, requestedBy = 'engineer') => event({ seq, type: 'system.restart.requested', actor: 'system', threadId: 't1', payload: { reason: 'a build', requestedBy } });
const completed = (seq: bigint, requestSeq: number) => event({ seq, type: 'system.restart.completed', actor: 'system', targetThreadId: 'main', payload: { reason: 'a build', requestSeq } });
const exception = (seq: bigint) => event({ seq, type: 'system.exception', actor: 'system', workspaceId: null, payload: { scope: 'migrate-deploy', error: 'failed' } });

describe('the system log of the store', () => {
  it('starts from the snapshot in seq order and takes the tail by seq, a held seq once', () => {
    resetSeq();

    let state = systemReducer(initialSystem, snapshotLoadDone(snapshot({ systemLog: [completed(5n, 3), requested(3n), requested(3n)] })));

    assert.deepEqual(
      state.log.map(e => e.seq),
      [3n, 5n],
    );

    state = systemReducer(state, eventAction(exception(4n)));
    state = systemReducer(state, eventAction(requested(7n)));

    const same = systemReducer(state, eventAction(requested(7n)));

    assert.equal(same, state);
    assert.deepEqual(
      state.log.map(e => e.seq),
      [3n, 4n, 5n, 7n],
    );
    assert.equal(state.restartsChanged, 0);

    state = systemReducer(state, eventAction(event({ seq: 8n, type: 'user.message', actor: 'user', payload: { text: 'x', source: 'web' } })));
    assert.deepEqual(
      state.log.map(e => e.seq),
      [3n, 4n, 5n, 7n],
    );
  });

  it('keeps the newest KEEP and moves the restarts stamp on every completion', () => {
    let state = systemReducer(initialSystem, snapshotLoadDone(snapshot({ systemLog: [] })));

    for (let i = 1; i <= KEEP + 5; i += 1) {
      state = systemReducer(state, eventAction(exception(BigInt(i))));
    }

    assert.equal(state.log.length, KEEP);
    assert.equal(state.log[0].seq, 6n);

    state = systemReducer(state, eventAction(completed(100n, 1)));
    assert.equal(state.restartsChanged, 1);
    assert.equal(state.log[state.log.length - 1].seq, 100n);
    assert.equal(state.log.length, KEEP);
  });

  it('reads a snapshot of an older server, without the log, as empty', () => {
    const older = { ...snapshot(), systemLog: undefined as never };
    const state = systemReducer(initialSystem, snapshotLoadDone(older));

    assert.deepEqual(state.log, []);
  });
});

describe('the restart in the way', () => {
  it('is the newest request after the newest completion, and none once completed', () => {
    assert.equal(pendingRestartOf([]), null);
    assert.equal(pendingRestartOf([requested(3n)])?.seq, 3n);
    assert.equal(pendingRestartOf([requested(3n), exception(4n)])?.seq, 3n);
    assert.equal(pendingRestartOf([requested(3n), completed(5n, 3)]), null);
    assert.equal(pendingRestartOf([requested(3n), completed(5n, 3), requested(7n), requested(9n)])?.seq, 9n);
    assert.equal(pendingRestartOf([requested(3n), completed(5n, 3), exception(6n)]), null);
  });
});
