// The uploads to the file area (design: Upload, UploadItem, ClashItem; rule
// 23): one corner panel for the files sent to the disk — each a row
// waiting, uploading with its progress, done (its path as placed) or failed
// with the reason and whether Retry can help — folded to one line on
// request while anything runs; and the clashes of names waiting for the
// one answer of the dialog. A new batch while nothing runs starts the panel
// anew. Two files upload at a time (UPLOAD_PARALLEL); the rest wait.

import { TOO_LARGE, isTooLarge } from '../../lib/upload/words.ts';
import type { UploadError } from '../../lib/upload/words.ts';
import type { Action } from '../types.ts';
import type { ExistingEntry } from './actions.ts';

export const UPLOAD_PARALLEL = 2;

export type UploadMode = 'create' | 'replace' | 'keep';

export type UploadRow = {
  id: string;
  folder: string;
  name: string;
  size: number;
  type: string;
  mode: UploadMode;
  state: 'wait' | 'up' | 'done' | 'err';
  loaded: number;
  // The path the file got (a kept one is "name (2).ext").
  path: string | null;
  error: UploadError | null;
};

// A file whose name is taken in its folder, with what is there now (null
// facts when only the server said so).
export type Clash = { id: string; folder: string; name: string; size: number; type: string; existing: ExistingEntry | null };

export type UploadsState = {
  rows: UploadRow[];
  // The folder of the newest batch — the panel's "to <path>".
  folder: string;
  folded: boolean;
  clashes: Clash[];
  // Names of each folder with a clash, as the listing gave them: what
  // "Keep both" will be called is told from them.
  taken: Record<string, string[]>;
};

export const initialUploads: UploadsState = { rows: [], folder: '', folded: false, clashes: [], taken: {} };

export function isRunning(row: UploadRow): boolean {
  return row.state === 'wait' || row.state === 'up';
}

function row(file: { id: string; folder: string; name: string; size: number; type: string }, mode: UploadMode): UploadRow {
  return { ...file, mode, loaded: 0, path: null, ...(isTooLarge(file.size) ? { state: 'err' as const, error: TOO_LARGE } : { state: 'wait' as const, error: null }) };
}

function patch(state: UploadsState, id: string, change: (row: UploadRow) => UploadRow): UploadsState {
  let changed = false;
  const rows = state.rows.map(current => {
    if (current.id !== id) {
      return current;
    }

    const next = change(current);

    changed ||= next !== current;

    return next;
  });

  return changed ? { ...state, rows } : state;
}

export function uploadsReducer(state: UploadsState = initialUploads, action: Action): UploadsState {
  switch (action.type) {
    case 'UPLOAD_FILES': {
      const existing = new Map(action.existing.map(entry => [entry.name, entry]));
      const fresh = !state.rows.some(isRunning) && state.clashes.length === 0;
      const rows: UploadRow[] = [];
      const clashes: Clash[] = [];

      for (const file of action.files) {
        const there = existing.get(file.name);
        const item = { id: file.id, folder: action.folder, name: file.name, size: file.size, type: file.type };

        if (there && !isTooLarge(file.size)) {
          clashes.push({ ...item, existing: there });
        } else {
          rows.push(row(item, 'create'));
        }
      }

      return {
        rows: [...(fresh ? [] : state.rows), ...rows],
        folder: action.folder,
        folded: fresh ? false : state.folded,
        clashes: [...state.clashes, ...clashes],
        taken: clashes.length ? { ...state.taken, [action.folder]: action.existing.map(entry => entry.name) } : state.taken,
      };
    }
    case 'UPLOAD_CLASH_ANSWER':
      return {
        ...state,
        rows: action.choice === 'skip' ? state.rows : [...state.rows, ...state.clashes.map(clash => row(clash, action.choice as UploadMode))],
        clashes: [],
        taken: {},
      };
    case 'UPLOAD_START':
      return patch(state, action.id, current => (current.state === 'wait' ? { ...current, state: 'up', loaded: 0 } : current));
    case 'UPLOAD_PROGRESS':
      return patch(state, action.id, current => (current.state === 'up' && current.loaded !== action.loaded ? { ...current, loaded: action.loaded } : current));
    case 'UPLOAD_DONE':
      return patch(state, action.id, current => (current.state === 'up' ? { ...current, state: 'done', loaded: current.size, path: action.path } : current));
    case 'UPLOAD_FAIL':
      return patch(state, action.id, current => (current.state === 'up' ? { ...current, state: 'err', error: action.error } : current));
    case 'UPLOAD_EXISTS': {
      const current = state.rows.find(candidate => candidate.id === action.id);

      if (!current || current.state !== 'up') {
        return state;
      }

      return {
        ...state,
        rows: state.rows.filter(candidate => candidate.id !== action.id),
        clashes: [...state.clashes, { id: current.id, folder: current.folder, name: current.name, size: current.size, type: current.type, existing: null }],
      };
    }
    case 'UPLOAD_CANCEL': {
      const rows = state.rows.filter(candidate => candidate.id !== action.id);

      return rows.length === state.rows.length ? state : { ...state, rows, folded: rows.length ? state.folded : false };
    }
    case 'UPLOAD_RETRY':
      return patch(state, action.id, current => (current.state === 'err' && current.error?.retry !== false ? { ...current, state: 'wait', loaded: 0, error: null } : current));
    case 'UPLOAD_FOLD':
      return state.folded === action.folded ? state : { ...state, folded: action.folded };
    case 'UPLOAD_CLOSE':
      return state.rows.some(isRunning) ? state : { ...state, rows: [], folded: false };
    default:
      return state;
  }
}
