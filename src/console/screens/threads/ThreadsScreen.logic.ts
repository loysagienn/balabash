// What the body of the Threads screen shows. The stage of the first page is
// read from the list's request state, never from how many rows the filters
// left: a failed first attempt is "failed", an exhausted set with no rows is
// "empty". The status line at the end (the next page's sentinel, a failed
// page with Retry) belongs to the loaded range, so it stays whether the rows
// or the empty state are shown.

import { hasLoadedPage } from '../../store/threads/selectors.ts';
import type { ThreadsListState } from '../../store/threads/reducer.ts';

export type ThreadsBody = 'skeleton' | 'failed' | 'empty' | 'rows';
export type ThreadsFoot = 'retry' | 'more' | null;

export function threadsBody(list: ThreadsListState, visible: number): ThreadsBody {
  if (!hasLoadedPage(list)) {
    return list.error && !list.loading ? 'failed' : 'skeleton';
  }

  return visible === 0 ? 'empty' : 'rows';
}

export function threadsFoot(list: ThreadsListState): ThreadsFoot {
  return list.error ? 'retry' : list.nextCursor !== null ? 'more' : null;
}

// The explanation under "No threads match": how far the list has looked.
export function emptyMatchNote(foot: ThreadsFoot): string {
  switch (foot) {
    case 'more':
      return 'Earlier threads are still loading.';
    case 'retry':
      return 'Earlier threads could not be loaded.';
    default:
      return 'Nothing with these filters in the whole list.';
  }
}
