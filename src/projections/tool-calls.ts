export type ActionGroup<T> = { kind: 'group'; items: T[] } | { kind: 'single'; item: T };

// Consecutive actions become one group (the feed's collapsed run of tool
// lines); everything else passes through alone. A lone action stays a
// group of one — the feed renders it as a line, not a block.
export function groupActions<T>(items: T[], isAction: (item: T) => boolean): ActionGroup<T>[] {
  const result: ActionGroup<T>[] = [];
  let run: T[] | null = null;

  for (const item of items) {
    if (isAction(item)) {
      if (!run) {
        run = [];
        result.push({ kind: 'group', items: run });
      }

      run.push(item);
    } else {
      run = null;
      result.push({ kind: 'single', item });
    }
  }

  return result;
}
