// The editor's rules (FileEditor.tsx): which file it edits, what the
// textarea shows, when the draft is unsaved, what a failed save means.
// Pure, tested.

import type { WorkspaceFileMeta } from '../../../api/contract.ts';
import { ApiError } from '../../lib/api/index.ts';
import { viewerFor } from './node.ts';

// A draft: the text typed and the validator (the ETag) of the content it
// started from — the write names that one (If-Match), whatever the file
// became meanwhile.
export type Draft = { text: string; etag: string | null };

// The editable kind: Markdown that previews (the size rule is the
// preview's — a text too large to show is too large to edit in a tab).
export function canEdit(file: Pick<WorkspaceFileMeta, 'path' | 'sizeBytes' | 'mediaType'>): boolean {
  return viewerFor(file).kind === 'markdown';
}

// What the textarea shows: the draft, else the loaded content.
export function editorText(draft: Draft | null, loaded: string | undefined): string {
  return draft?.text ?? loaded ?? '';
}

// Unsaved: a draft that differs from the content as the editor knows it.
export function isDirty(draft: Draft | null, loaded: string | undefined): boolean {
  return draft !== null && draft.text !== loaded;
}

// The draft after a keystroke: the validator is taken at the first edit and
// kept — a reload under the draft (the file changed, the node refetched)
// does not move it, so the write still names the content the draft saw.
export function typed(draft: Draft | null, text: string, loadedEtag: string | null): Draft {
  return { text, etag: draft ? draft.etag : loadedEtag };
}

// The draft after a save: gone when the saved text is what the textarea
// holds; keystrokes typed during the save stay, now over the saved content.
export function saved(draft: Draft | null, savedText: string, etag: string): Draft | null {
  return draft === null || draft.text === savedText ? null : { text: draft.text, etag };
}

export type SaveFailure = { kind: 'conflict' | 'error'; message: string };

// A failed save: a 412 is the file changed under the draft (the user
// chooses — overwrite, or cancel and see theirs); anything else is reported
// as it came.
export function saveFailure(error: unknown): SaveFailure {
  if (error instanceof ApiError && error.status === 412) {
    return { kind: 'conflict', message: error.message };
  }

  return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}
