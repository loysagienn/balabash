import type { AppsResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { AppsRequest } from './reducer.ts';

// The listing read again (GET /api/apps): the Apps screen entered, the tab
// came back into view, a Retry. The answer replaces the rows — the snapshot
// and the tail know only publications, not a folder written after the
// snapshot nor a manifest edited since. `request` — the read the answer
// belongs to (apps.refresh.request as the reducer created it on LOAD_APPS):
// the reducer applies a listing only while the store still waits for that
// very request and no app.* event has arrived since it left (the listing
// could predate the event).
export const loadApps = () => ({ type: 'LOAD_APPS' }) as const;
export const loadAppsDone = (request: AppsRequest, apps: AppsResponse) => ({ type: 'LOAD_APPS_DONE', request, apps }) as const;
export const loadAppsFail = (request: AppsRequest, error: ApiFailure) => ({ type: 'LOAD_APPS_FAIL', request, error }) as const;
