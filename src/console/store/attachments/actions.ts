import type { StoredFileMeta } from '../../../api/contract.ts';
import type { UploadError } from '../../lib/upload/words.ts';

// A file picked for the draft: its id in the upload registry
// (lib/upload/registry.ts — the File itself lives there), its facts, and
// an object URL of an image for the chip's preview.
export type PickedFile = { id: string; name: string; size: number; type: string; preview: string | null };

// Files picked (paperclip, dropped on the thread, pasted): each uploads at
// once.
export const attachFiles = (threadId: string, files: PickedFile[]) => ({ type: 'ATTACH_FILES', threadId, files }) as const;
// One upload of a draft file — the first, or a retry after a failure.
export const uploadAttachment = (threadId: string, id: string) => ({ type: 'ATTACHMENT_UPLOAD', threadId, id }) as const;
export const attachmentProgress = (threadId: string, id: string, loaded: number) => ({ type: 'ATTACHMENT_UPLOAD_PROGRESS', threadId, id, loaded }) as const;
export const attachmentDone = (threadId: string, id: string, file: StoredFileMeta) => ({ type: 'ATTACHMENT_UPLOAD_DONE', threadId, id, file }) as const;
export const attachmentFail = (threadId: string, id: string, error: UploadError) => ({ type: 'ATTACHMENT_UPLOAD_FAIL', threadId, id, error }) as const;
// The chip's ×: an upload in flight is cut off; a stored file only leaves
// the draft (storage keeps it).
export const removeAttachment = (threadId: string, id: string) => ({ type: 'ATTACHMENT_REMOVE', threadId, id }) as const;
