import type { State } from '../types.ts';

export const selectStream = (state: State) => state.stream;
export const selectAsOfSeq = (state: State) => state.stream.asOfSeq;
export const selectSnapshotReady = (state: State) => state.stream.asOfSeq !== null;
