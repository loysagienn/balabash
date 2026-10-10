import type { AppsResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

// The listing read again (GET /api/apps): the Apps screen opened, the tab
// came back into view, a Retry. The answer replaces the rows — the snapshot
// and the tail know only publications, not a folder written after the
// snapshot nor a manifest edited since. `since` — apps.eventSeq when the
// request left: the reducer applies a listing only if no app.* event has
// changed the rows meanwhile (the listing could predate the event).
export const loadApps = () => ({ type: 'LOAD_APPS' }) as const;
export const loadAppsDone = (apps: AppsResponse, since: bigint | null) => ({ type: 'LOAD_APPS_DONE', apps, since }) as const;
export const loadAppsFail = (error: ApiFailure) => ({ type: 'LOAD_APPS_FAIL', error }) as const;
