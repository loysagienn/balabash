// The draft attachments of the composer, per thread (design: AttDraft,
// rule 23): each picked file is a chip that uploads at once — uploading
// with its progress, done with its stored fileId, or failed with the reason
// and whether Retry can help. Send waits while any uploads; a failed chip
// neither blocks nor goes. The last refusal of a send stays beside the
// draft (the strip above the composer) until the next send: the thread
// closed, files not accepted (their chips turn "Not accepted"), the
// connection lost, anything else. The draft lives as long as the tab; a
// sent message takes its files out of it.

import type { ApiFailure } from '../../lib/api/index.ts';
import { TOO_LARGE, isTooLarge } from '../../lib/upload/words.ts';
import type { UploadError } from '../../lib/upload/words.ts';
import type { Action } from '../types.ts';

export type DraftAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  image: boolean;
  // An object URL of the picked image (the chip's preview and the viewer).
  preview: string | null;
  state: 'up' | 'done' | 'err';
  loaded: number;
  fileId: string | null;
  error: UploadError | null;
};

export type SendRefusal = { kind: 'closed' | 'files' | 'network' | 'other'; message: string; count: number };

export type AttachmentsState = {
  byThread: Record<string, DraftAttachment[]>;
  refusal: Record<string, SendRefusal>;
};

export const initialAttachments: AttachmentsState = { byThread: {}, refusal: {} };

export const NOT_ACCEPTED: UploadError = { reason: 'Not accepted', retry: false };

function update(state: AttachmentsState, threadId: string, change: (atts: DraftAttachment[]) => DraftAttachment[]): AttachmentsState {
  const current = state.byThread[threadId];

  if (!current) {
    return state;
  }

  const next = change(current);

  if (next === current) {
    return state;
  }

  const { [threadId]: dropped, ...rest } = state.byThread;

  return { ...state, byThread: next.length ? { ...rest, [threadId]: next } : rest };
}

function patch(state: AttachmentsState, threadId: string, id: string, change: (att: DraftAttachment) => DraftAttachment): AttachmentsState {
  return update(state, threadId, atts => {
    let changed = false;
    const next = atts.map(att => {
      if (att.id !== id) {
        return att;
      }

      const after = change(att);

      changed ||= after !== att;

      return after;
    });

    return changed ? next : atts;
  });
}

function withoutRefusal(state: AttachmentsState, threadId: string): AttachmentsState {
  if (!state.refusal[threadId]) {
    return state;
  }

  const { [threadId]: dropped, ...rest } = state.refusal;

  return { ...state, refusal: rest };
}

export function refusalOf(error: ApiFailure): SendRefusal {
  if (error.code === 'thread_closed') {
    return { kind: 'closed', message: error.message, count: 0 };
  }

  if (error.code === 'file_not_accepted') {
    return { kind: 'files', message: error.message, count: error.fileIds?.length ?? 1 };
  }

  if (error.code === 'network' || error.status === 0) {
    return { kind: 'network', message: error.message, count: 0 };
  }

  return { kind: 'other', message: error.message, count: 0 };
}

export function attachmentsReducer(state: AttachmentsState = initialAttachments, action: Action): AttachmentsState {
  switch (action.type) {
    case 'ATTACH_FILES': {
      const added = action.files.map(
        (file): DraftAttachment => ({
          id: file.id,
          name: file.name,
          size: file.size,
          type: file.type,
          image: file.type.startsWith('image/'),
          preview: file.preview,
          ...(isTooLarge(file.size) ? { state: 'err' as const, error: TOO_LARGE } : { state: 'up' as const, error: null }),
          loaded: 0,
          fileId: null,
        }),
      );

      return added.length ? { ...state, byThread: { ...state.byThread, [action.threadId]: [...(state.byThread[action.threadId] ?? []), ...added] } } : state;
    }
    case 'ATTACHMENT_UPLOAD':
      return patch(state, action.threadId, action.id, att => (att.state === 'up' && att.loaded === 0 ? att : { ...att, state: 'up', loaded: 0, error: null, fileId: null }));
    case 'ATTACHMENT_UPLOAD_PROGRESS':
      return patch(state, action.threadId, action.id, att => (att.state === 'up' && att.loaded !== action.loaded ? { ...att, loaded: action.loaded } : att));
    case 'ATTACHMENT_UPLOAD_DONE':
      return patch(state, action.threadId, action.id, att => (att.state === 'up' ? { ...att, state: 'done', loaded: att.size, fileId: action.file.fileId } : att));
    case 'ATTACHMENT_UPLOAD_FAIL':
      return patch(state, action.threadId, action.id, att => (att.state === 'up' ? { ...att, state: 'err', error: action.error } : att));
    case 'ATTACHMENT_REMOVE': {
      const next = update(state, action.threadId, atts => atts.filter(att => att.id !== action.id));
      const refusal = next.refusal[action.threadId];

      // "Remove it and send again": once no refused chip is left, the
      // strip has said its piece.
      if (refusal?.kind === 'files' && !(next.byThread[action.threadId] ?? []).some(att => att.error?.reason === NOT_ACCEPTED.reason)) {
        return withoutRefusal(next, action.threadId);
      }

      return next;
    }
    case 'SEND_MESSAGE':
      return withoutRefusal(state, action.threadId);
    case 'SEND_MESSAGE_DONE': {
      const sent = new Set(action.fileIds);

      return withoutRefusal(
        update(state, action.threadId, atts => (sent.size ? atts.filter(att => !(att.fileId && sent.has(att.fileId))) : atts)),
        action.threadId,
      );
    }
    case 'SEND_MESSAGE_FAIL': {
      const refused = new Set(action.error.fileIds ?? []);
      const marked = refused.size
        ? update(state, action.threadId, atts => atts.map(att => (att.fileId && refused.has(att.fileId) ? { ...att, state: 'err', error: NOT_ACCEPTED } : att)))
        : state;

      return { ...marked, refusal: { ...marked.refusal, [action.threadId]: refusalOf(action.error) } };
    }
    default:
      return state;
  }
}
