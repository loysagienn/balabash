import type { State } from '../types.ts';

export const selectStream = (state: State) => state.stream;
export const selectAsOfSeq = (state: State) => state.stream.asOfSeq;
export const selectSnapshotReady = (state: State) => state.stream.asOfSeq !== null;

export type SnapshotStage = 'loading' | 'failed' | 'ready';

// The stage of a screen drawn from the snapshot alone (Home, Apps, Agents):
// the first snapshot in flight, failed before any landed, or the data on
// screen.
export function snapshotStage(stream: { asOfSeq: bigint | null; snapshot: { pending: boolean; error: { message: string } | null } }): SnapshotStage {
  if (stream.asOfSeq !== null) {
    return 'ready';
  }

  return stream.snapshot.error && !stream.snapshot.pending ? 'failed' : 'loading';
}

export const selectSnapshotStage = (state: State): SnapshotStage => snapshotStage(state.stream);
