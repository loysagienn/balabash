import type { AppsResponse, PublicationResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { AppCall, AppsRequest } from './reducer.ts';

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

// The operator's publication of an app folder under a slug and its end
// (POST /api/apps/publish, /unpublish). One call per app at a time — the
// call in flight is apps.calls[path], and the outcome names it (`request`):
// the reducer applies an outcome only while the store still waits for
// exactly that call. The answer's slug is folded into the row at once; the
// same change comes back as app.published / app.unpublished of the tail,
// idempotently.
export const publishApp = (path: string, slug: string) => ({ type: 'PUBLISH_APP', path, slug }) as const;
export const publishAppDone = (path: string, request: AppCall, publication: PublicationResponse) => ({ type: 'PUBLISH_APP_DONE', path, request, publication }) as const;
export const publishAppFail = (path: string, request: AppCall, error: ApiFailure) => ({ type: 'PUBLISH_APP_FAIL', path, request, error }) as const;
export const unpublishApp = (path: string) => ({ type: 'UNPUBLISH_APP', path }) as const;
export const unpublishAppDone = (path: string, request: AppCall, publication: PublicationResponse) => ({ type: 'UNPUBLISH_APP_DONE', path, request, publication }) as const;
export const unpublishAppFail = (path: string, request: AppCall, error: ApiFailure) => ({ type: 'UNPUBLISH_APP_FAIL', path, request, error }) as const;
