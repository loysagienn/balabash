// The uploads of the draft: each picked file goes to storage at once
// (api.files.upload — XHR with progress), its progress reported at most a
// few times a second; a chip removed while uploading cuts its request off.
// A late answer for a chip no longer in the draft is dropped. The bytes
// and the requests live in the upload registry (lib/upload/registry.ts).

import { toApiFailure } from '../../lib/api/index.ts';
import { cancelTransfer, endTransfer, fileOf, forget, startTransfer } from '../../lib/upload/registry.ts';
import { isAbort } from '../../lib/api/upload.ts';
import { uploadError } from '../../lib/upload/words.ts';
import type { ActionHandler, State } from '../types.ts';
import { attachmentDone, attachmentFail, attachmentProgress, uploadAttachment } from './actions.ts';

// How often the progress of one upload reaches the store.
const PROGRESS_EVERY_MS = 120;

function attachmentOf(state: State, threadId: string, id: string) {
  return state.attachments.byThread[threadId]?.find(att => att.id === id) ?? null;
}

function revoke(preview: string | null): void {
  if (preview?.startsWith('blob:')) {
    URL.revokeObjectURL(preview);
  }
}

export const attachFilesHandler: ActionHandler<'ATTACH_FILES'> =
  ({ dispatch, getState, next }) =>
  action => {
    next(action);

    for (const file of action.files) {
      // Over the limit the chip is a refusal from the start: no request.
      if (attachmentOf(getState(), action.threadId, file.id)?.state === 'up') {
        dispatch(uploadAttachment(action.threadId, file.id));
      }
    }
  };

export const uploadAttachmentHandler: ActionHandler<'ATTACHMENT_UPLOAD'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { threadId, id } = action;
    const att = attachmentOf(getState(), threadId, id);
    const file = fileOf(id);

    if (!att || (att.state === 'err' && att.error?.retry === false)) {
      return;
    }

    next(action);

    if (!file) {
      dispatch(attachmentFail(threadId, id, { reason: 'Upload failed', retry: false }));

      return;
    }

    const controller = startTransfer(id);
    let reported = 0;

    try {
      const { file: stored } = await api.files.upload(file, att.name, {
        signal: controller.signal,
        onProgress: loaded => {
          const now = Date.now();

          if (now - reported >= PROGRESS_EVERY_MS) {
            reported = now;
            dispatch(attachmentProgress(threadId, id, loaded));
          }
        },
      });

      if (attachmentOf(getState(), threadId, id)?.state === 'up') {
        dispatch(attachmentDone(threadId, id, stored));
      }
    } catch (error) {
      if (!isAbort(error) && attachmentOf(getState(), threadId, id)?.state === 'up') {
        dispatch(attachmentFail(threadId, id, uploadError(toApiFailure(error))));
      }
    } finally {
      endTransfer(id, controller);
    }
  };

export const removeAttachmentHandler: ActionHandler<'ATTACHMENT_REMOVE'> =
  ({ getState, next }) =>
  action => {
    const att = attachmentOf(getState(), action.threadId, action.id);

    forget(action.id);
    revoke(att?.preview ?? null);
    next(action);
  };

// The files of a sent message leave the draft: their bytes and previews go.
export function forgetSent(state: State, threadId: string, fileIds: string[]): void {
  const sent = new Set(fileIds);

  for (const att of state.attachments.byThread[threadId] ?? []) {
    if (att.fileId && sent.has(att.fileId)) {
      cancelTransfer(att.id);
      forget(att.id);
      revoke(att.preview);
    }
  }
}
