// The listings of the file area (['workspace', path], features/file-area/
// queries.ts) against the uploads of the store: a file that has landed is
// new in its folder, so once a row turns done the folder's listing (and the
// node of the placed path, a replaced file's preview) is invalidated — a
// mounted list refetches at once and the file appears, one left in the
// cache refetches on its next mount. A process, not a handler: lives for
// the tab, only invalidates.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import type { InvalidatingQueryClient } from './schedule.ts';

// The queries to invalidate for rows that turned done since `seen`.
export function landedKeys(rows: State['uploads']['rows'], seen: ReadonlySet<string>): { ids: string[]; keys: string[][] } {
  const ids: string[] = [];
  const keys: string[][] = [];

  for (const row of rows) {
    if (row.state === 'done' && row.path !== null && !seen.has(row.id)) {
      ids.push(row.id);
      keys.push(['workspace', row.folder], ['workspace', row.path]);
    }
  }

  return { ids, keys };
}

export function connectQueryClientToUploads(store: Store<State, Action>, queryClient: InvalidatingQueryClient): () => void {
  const seen = new Set<string>();
  let rows = store.getState().uploads.rows;

  return store.subscribe(() => {
    const now = store.getState().uploads.rows;

    if (now === rows) {
      return;
    }

    rows = now;

    const landed = landedKeys(now, seen);

    for (const id of landed.ids) {
      seen.add(id);
    }

    for (const queryKey of landed.keys) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  });
}
