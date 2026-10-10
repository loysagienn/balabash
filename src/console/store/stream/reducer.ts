// Where the store stands against the log: asOfSeq from the snapshot, lastSeq
// from the tail, the connection status of the stream process, and — while
// the tail is not flowing — dataAt, the moment it stopped: the data on
// screen is known current up to then ("Data as of 16:31" on Home). The time
// of the break rather than of the last event: a quiet log has no event for
// hours while the screen stays exact. Null while the tail flows, and when
// it never flowed (the first opening failed — the snapshot is the data).

import type { ApiFailure } from '../../lib/api/index.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export type StreamState = {
  status: StreamStatus;
  lastSeq: bigint | null;
  asOfSeq: bigint | null;
  dataAt: Date | null;
  snapshot: { pending: boolean; error: ApiFailure | null };
};

export const initialStream: StreamState = {
  status: 'idle',
  lastSeq: null,
  asOfSeq: null,
  dataAt: null,
  snapshot: { pending: false, error: null },
};

export function streamReducer(state: StreamState = initialStream, action: Action): StreamState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD':
      return { ...state, snapshot: { pending: true, error: null } };
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, asOfSeq: action.snapshot.asOfSeq, lastSeq: null, snapshot: { pending: false, error: null } };
    case 'SNAPSHOT_LOAD_FAIL':
      return { ...state, snapshot: { pending: false, error: action.error } };
    case 'STREAM_CONNECTING':
      return { ...state, status: 'connecting' };
    case 'STREAM_OPENED':
      return { ...state, status: 'open', dataAt: null };
    case 'STREAM_RECONNECTING':
      // Only the first break stamps the moment: later failed attempts are
      // the same outage. A tail that had opened before (open) was current
      // up to the break; one that never opened (connecting) leaves the
      // snapshot as the data, with no moment to name.
      return state.status === 'reconnecting' ? state : { ...state, status: 'reconnecting', dataAt: state.status === 'open' ? action.at : null };
    case 'STREAM_CLOSED':
      return { ...state, status: 'idle', dataAt: null };
    default:
      if (isEventAction(action)) {
        const seq = action.event.seq;

        return state.lastSeq !== null && seq <= state.lastSeq ? state : { ...state, lastSeq: seq };
      }

      return state;
  }
}
