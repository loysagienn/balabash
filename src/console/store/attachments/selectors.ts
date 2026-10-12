import type { State } from '../types.ts';
import type { DraftAttachment, SendRefusal } from './reducer.ts';

const NONE: DraftAttachment[] = [];

export const selectDraftAttachments = (state: State, threadId: string): DraftAttachment[] => state.attachments.byThread[threadId] ?? NONE;
export const selectSendRefusal = (state: State, threadId: string): SendRefusal | null => state.attachments.refusal[threadId] ?? null;

// What the draft's files mean for Send: how many still upload (Send waits)
// and the stored ones that go with the message.
export function draftFiles(atts: DraftAttachment[]): { uploading: number; ready: string[] } {
  return {
    uploading: atts.filter(att => att.state === 'up').length,
    ready: atts.flatMap(att => (att.state === 'done' && att.fileId ? [att.fileId] : [])),
  };
}
