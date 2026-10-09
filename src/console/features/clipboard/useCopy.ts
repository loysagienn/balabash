// Copy a text to the clipboard and tell the outcome with a toast: "Link
// copied", "Path copied" — the words come from the caller, the text itself
// is the toast's description. Resolves to whether the copy succeeded.

import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';

export type CopyWords = { done: string; fail: string };

export function useCopy(): (text: string, words: CopyWords) => Promise<boolean> {
  const dispatch = useAppDispatch();

  return async (text, words) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatch(pushToast({ title: words.done, desc: text, state: 'done' }));

      return true;
    } catch {
      dispatch(pushToast({ title: words.fail, desc: text, state: 'err' }));

      return false;
    }
  };
}
