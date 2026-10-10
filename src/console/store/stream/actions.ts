import type { SnapshotResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export const snapshotLoad = () => ({ type: 'SNAPSHOT_LOAD' }) as const;
export const snapshotLoadDone = (snapshot: SnapshotResponse) => ({ type: 'SNAPSHOT_LOAD_DONE', snapshot }) as const;
export const snapshotLoadFail = (error: ApiFailure) => ({ type: 'SNAPSHOT_LOAD_FAIL', error }) as const;

export const streamConnecting = () => ({ type: 'STREAM_CONNECTING' }) as const;
export const streamOpened = () => ({ type: 'STREAM_OPENED' }) as const;
// `at` — the moment the tail stopped flowing (the process's clock): the
// data on screen is known current up to then.
export const streamReconnecting = (at: Date) => ({ type: 'STREAM_RECONNECTING', at }) as const;
export const streamClosed = () => ({ type: 'STREAM_CLOSED' }) as const;
