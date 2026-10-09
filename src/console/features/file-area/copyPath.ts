// "Copy path" of a file: the relative path inside the file area — the
// currency agents, tools and URLs share — goes to the clipboard, the
// outcome is a toast.

import { useCopy } from '../clipboard/useCopy.ts';

const WORDS = { done: 'Path copied', fail: 'Couldn’t copy the path' };

export function useCopyPath(): (path: string) => Promise<void> {
  const copy = useCopy();

  return async path => {
    await copy(path, WORDS);
  };
}
