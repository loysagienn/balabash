// Where the store stands against the log: asOfSeq from the snapshot, lastSeq
// from the tail, the connection status of the stream process.

import type { ApiFailure } from '../../lib/api/index.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export type StreamState = {
  status: StreamStatus;
  lastSeq: bigint | null;
  asOfSeq: bigint | null;
  snapshot: { pending: boolean; error: ApiFailure | null };
};

export const initialStream: StreamState = {
  status: 'idle',
  lastSeq: null,
  asOfSeq: null,
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
      return { ...state, status: 'open' };
    case 'STREAM_RECONNECTING':
      return { ...state, status: 'reconnecting' };
    case 'STREAM_CLOSED':
      return { ...state, status: 'idle' };
    default:
      if (isEventAction(action)) {
        const seq = action.event.seq;

        return state.lastSeq !== null && seq <= state.lastSeq ? state : { ...state, lastSeq: seq };
      }

      return state;
  }
}
