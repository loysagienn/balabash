// "Copy path" of a file: the relative path inside the file area — the
// currency agents, tools and URLs share — goes to the clipboard, the
// outcome is a toast.

import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';

export function useCopyPath(): (path: string) => Promise<void> {
  const dispatch = useAppDispatch();

  return async path => {
    try {
      await navigator.clipboard.writeText(path);
      dispatch(pushToast({ title: 'Path copied', desc: path, state: 'done' }));
    } catch {
      dispatch(pushToast({ title: 'Couldn’t copy the path', desc: path, state: 'err' }));
    }
  };
}
