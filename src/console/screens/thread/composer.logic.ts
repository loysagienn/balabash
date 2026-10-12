// The composer's words about its files and its refusals (design: Composer,
// AttDraft, rule 23): what a draft chip reads in each state, why Send
// waits, and the strip above the box when a send was refused — the draft
// stays whole, the strip says why and what to do (Copy text for a thread
// that has closed, Retry for a lost connection or a server's refusal).

import type { ThreadStatus } from '../../../core/contract.ts';
import { fileSize } from '../../lib/format/index.ts';
import { percentOf, progressWords, uploadingWords } from '../../lib/upload/words.ts';
import type { DraftAttachment, SendRefusal } from '../../store/attachments/reducer.ts';

export type ChipWords = { status: string; progress?: number; state?: 'done' | 'err'; retry: boolean };

export function chipWords(att: DraftAttachment): ChipWords {
  switch (att.state) {
    case 'up':
      return { status: progressWords(att.loaded, att.size), progress: percentOf(att.loaded, att.size), retry: false };
    case 'done':
      return { status: fileSize(att.size), state: 'done', retry: false };
    case 'err':
      return { status: att.error?.reason ?? 'Upload failed', state: 'err', retry: att.error?.retry ?? true };
  }
}

// Why Send waits: "Uploading 2 files…", or nothing.
export function waitWords(uploading: number): string {
  return uploading > 0 ? uploadingWords(uploading) : '';
}

const CLOSED_WORDS: Partial<Record<ThreadStatus, string>> = { completed: 'has completed', failed: 'has failed', cancelled: 'was cancelled' };

export type RefusalWords = { text: string; action: 'copy' | 'retry' | null };

export function refusalWords(refusal: SendRefusal, status: ThreadStatus, draft: { text: boolean; files: boolean }): RefusalWords {
  switch (refusal.kind) {
    case 'closed': {
      const kept = draft.text && draft.files ? 'Your text and files are kept.' : draft.files ? 'Your files are kept.' : 'Your text is kept.';

      return { text: `Not sent — the thread ${CLOSED_WORDS[status] ?? 'has ended'}. ${kept}`, action: draft.text ? 'copy' : null };
    }
    case 'files':
      return refusal.count === 1
        ? { text: 'Not sent — 1 file was not accepted. Remove it and send again.', action: null }
        : { text: `Not sent — ${refusal.count} files were not accepted. Remove them and send again.`, action: null };
    case 'network':
      return { text: 'Not sent — the connection was lost.', action: 'retry' };
    case 'other':
      return { text: `Not sent — ${refusal.message.replace(/\.$/, '')}.`, action: 'retry' };
  }
}
