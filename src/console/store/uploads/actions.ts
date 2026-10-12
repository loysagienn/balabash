import type { UploadError } from '../../lib/upload/words.ts';

// A file picked for the file area (its bytes in the upload registry under
// the id) and what the folder's listing says is already under a name.
export type PickedUpload = { id: string; name: string; size: number; type: string };
export type ExistingEntry = { name: string; sizeBytes: number | null; modifiedAt: string | null; folder: boolean };

// The answer to a clash of names, one for all of them (design: 1a).
export type ClashChoice = 'skip' | 'replace' | 'keep';

// Files to upload into a folder (the Upload button, the system picker, a
// drop on the file area): the names the listing already has clash and are
// asked about first; the rest queue at once.
export const uploadFiles = (folder: string, files: PickedUpload[], existing: ExistingEntry[]) => ({ type: 'UPLOAD_FILES', folder, files, existing }) as const;
export const answerClash = (choice: ClashChoice) => ({ type: 'UPLOAD_CLASH_ANSWER', choice }) as const;
// One request of a queued file.
export const startUpload = (id: string) => ({ type: 'UPLOAD_START', id }) as const;
export const uploadProgress = (id: string, loaded: number) => ({ type: 'UPLOAD_PROGRESS', id, loaded }) as const;
export const uploadDone = (id: string, path: string) => ({ type: 'UPLOAD_DONE', id, path }) as const;
export const uploadFail = (id: string, error: UploadError) => ({ type: 'UPLOAD_FAIL', id, error }) as const;
// The server found the name taken after all (the listing was out of date):
// the file goes back to the clash dialog.
export const uploadExists = (id: string) => ({ type: 'UPLOAD_EXISTS', id }) as const;
// The row's ×: running — cancel the request; failed — remove the row.
export const cancelUpload = (id: string) => ({ type: 'UPLOAD_CANCEL', id }) as const;
export const retryUpload = (id: string) => ({ type: 'UPLOAD_RETRY', id }) as const;
export const foldUploads = (folded: boolean) => ({ type: 'UPLOAD_FOLD', folded }) as const;
// "×" of a finished panel.
export const closeUploads = () => ({ type: 'UPLOAD_CLOSE' }) as const;
