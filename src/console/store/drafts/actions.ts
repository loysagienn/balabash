import type { DraftView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

// What a draft is made of, as the server keeps it: the composer's text as
// typed and the stored files of its chips (the uploaded ones; an upload in
// flight is this tab's alone).
export type DraftContent = { text: string; fileIds: string[] };

// The server's draft of the thread, read in place (GET /threads/:id/draft):
// on opening the thread, on the tab coming back, after a reconnect and on
// the stream's `draft` frame. _DONE applies the content to the composer
// only when the tab has no unsaved edits of its own (applied); an
// unapplied answer changes nothing — the tab's own save will meet the
// server's revision and sort it out.
export const draftLoad = (threadId: string) => ({ type: 'DRAFT_LOAD', threadId }) as const;
export const draftLoadDone = (threadId: string, draft: DraftView | null, applied: boolean) => ({ type: 'DRAFT_LOAD_DONE', threadId, draft, applied }) as const;
export const draftLoadFail = (threadId: string, error: ApiFailure) => ({ type: 'DRAFT_LOAD_FAIL', threadId, error }) as const;

// A save of the composer's content over the revision the tab bases it on
// (PUT /threads/:id/draft) — scheduled by the sync process (lib/drafts)
// after the typing rests, forced when the tab goes out of view (keepalive:
// the request outlives the page). _DONE: the server holds `content` at
// `revision`; _CONFLICT: the server holds another device's content
// (server) — the tab keeps its own and asks; _FAIL: the request itself
// failed, the content stays unsaved.
export const draftSave = (threadId: string, options: { keepalive: boolean } = { keepalive: false }) => ({ type: 'DRAFT_SAVE', threadId, keepalive: options.keepalive }) as const;
export const draftSaveDone = (threadId: string, revision: number, content: DraftContent) => ({ type: 'DRAFT_SAVE_DONE', threadId, revision, content }) as const;
export const draftSaveConflict = (threadId: string, server: DraftView) => ({ type: 'DRAFT_SAVE_CONFLICT', threadId, server }) as const;
export const draftSaveFail = (threadId: string, error: ApiFailure) => ({ type: 'DRAFT_SAVE_FAIL', threadId, error }) as const;

// The stream's `draft` frame: the user's draft of the thread reached
// `revision` somewhere (another device, this tab's own save).
export const draftChangedRemotely = (threadId: string, revision: number) => ({ type: 'DRAFT_CHANGED_REMOTELY', threadId, revision }) as const;

// The answer to a conflict: take the other device's version into the
// composer, or keep this tab's — which is then saved over the server's
// revision.
export const draftUseTheirs = (threadId: string, theirs: DraftView) => ({ type: 'DRAFT_CONFLICT_USE_THEIRS', threadId, theirs }) as const;
export const draftKeepMine = (threadId: string) => ({ type: 'DRAFT_CONFLICT_KEEP_MINE', threadId }) as const;
