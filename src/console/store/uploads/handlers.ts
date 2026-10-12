// The uploads to the file area run as a queue: UPLOAD_PARALLEL requests at
// a time (api.workspace.upload — XHR with progress), the next waiting file
// starts as one ends. A taken name found by the server (409 exists — the
// listing was out of date) sends the file back to the clash dialog; a
// cancel cuts the request off (the server keeps nothing); a late answer
// for a row no longer uploading is dropped. The bytes and the requests
// live in the upload registry (lib/upload/registry.ts); the listing of the
// folder refreshes through lib/query/uploads.ts.

import { joinPath } from '../../features/file-area/node.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { isAbort } from '../../lib/api/upload.ts';
import { cancelTransfer, endTransfer, fileOf, forget, startTransfer } from '../../lib/upload/registry.ts';
import { uploadError } from '../../lib/upload/words.ts';
import type { ActionHandler, Dispatch, State } from '../types.ts';
import { startUpload, uploadDone, uploadExists, uploadFail, uploadProgress } from './actions.ts';
import { UPLOAD_PARALLEL } from './reducer.ts';

const PROGRESS_EVERY_MS = 120;

// Starts the waiting files while fewer than UPLOAD_PARALLEL run.
function pump(dispatch: Dispatch, getState: () => State): void {
  const { rows } = getState().uploads;
  let free = UPLOAD_PARALLEL - rows.filter(row => row.state === 'up').length;

  for (const row of rows) {
    if (free <= 0) {
      return;
    }

    if (row.state === 'wait') {
      dispatch(startUpload(row.id));
      free -= 1;
    }
  }
}

function rowOf(state: State, id: string) {
  return state.uploads.rows.find(row => row.id === id) ?? null;
}

export const uploadFilesHandler: ActionHandler<'UPLOAD_FILES'> =
  ({ dispatch, getState, next }) =>
  action => {
    const before = new Set(getState().uploads.rows.map(row => row.id));

    next(action);

    // Rows a new batch cleared away (the finished panel started anew).
    for (const id of before) {
      if (!rowOf(getState(), id)) {
        forget(id);
      }
    }

    pump(dispatch, getState);
  };

export const answerClashHandler: ActionHandler<'UPLOAD_CLASH_ANSWER'> =
  ({ dispatch, getState, next }) =>
  action => {
    const skipped = action.choice === 'skip' ? getState().uploads.clashes.map(clash => clash.id) : [];

    next(action);
    skipped.forEach(forget);
    pump(dispatch, getState);
  };

export const startUploadHandler: ActionHandler<'UPLOAD_START'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { id } = action;
    const row = rowOf(getState(), id);

    if (row?.state !== 'wait') {
      return;
    }

    next(action);

    const file = fileOf(id);

    if (!file) {
      dispatch(uploadFail(id, { reason: 'Upload failed', retry: false }));
      pump(dispatch, getState);

      return;
    }

    const controller = startTransfer(id);
    let reported = 0;

    try {
      const { file: placed } = await api.workspace.upload(joinPath(row.folder, row.name), file, {
        ...(row.mode === 'create' ? {} : { conflict: row.mode }),
        signal: controller.signal,
        onProgress: loaded => {
          const now = Date.now();

          if (now - reported >= PROGRESS_EVERY_MS) {
            reported = now;
            dispatch(uploadProgress(id, loaded));
          }
        },
      });

      if (rowOf(getState(), id)?.state === 'up') {
        dispatch(uploadDone(id, placed.path));
      }
    } catch (error) {
      if (!isAbort(error) && rowOf(getState(), id)?.state === 'up') {
        const failure = toApiFailure(error);

        dispatch(failure.status === 409 && failure.code === 'exists' ? uploadExists(id) : uploadFail(id, uploadError(failure)));
      }
    } finally {
      endTransfer(id, controller);
    }

    pump(dispatch, getState);
  };

export const cancelUploadHandler: ActionHandler<'UPLOAD_CANCEL'> =
  ({ dispatch, getState, next }) =>
  action => {
    cancelTransfer(action.id);
    forget(action.id);
    next(action);
    pump(dispatch, getState);
  };

export const retryUploadHandler: ActionHandler<'UPLOAD_RETRY'> =
  ({ dispatch, getState, next }) =>
  action => {
    next(action);
    pump(dispatch, getState);
  };

export const closeUploadsHandler: ActionHandler<'UPLOAD_CLOSE'> =
  ({ getState, next }) =>
  action => {
    const ids = getState().uploads.rows.map(row => row.id);

    next(action);

    if (getState().uploads.rows.length === 0) {
      ids.forEach(forget);
    }
  };
