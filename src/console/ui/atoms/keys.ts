// Keyboard movement inside a group of items — a tablist (Tabs, Seg) or a
// menu. stepIndex is the pure rule: where a key moves from an index (−1 —
// the focus is not on an item yet); arrows wrap around, Home and End jump
// to the edges, any other key is null. stepFocus applies it to the items
// matched by a selector inside the event's current target; activate also
// clicks the item it moves to (a tab selects as it is reached).

import type { KeyboardEvent } from 'react';

export type Axis = 'x' | 'y';

export function stepIndex(key: string, index: number, count: number, axis: Axis): number | null {
  if (count === 0) {
    return null;
  }

  const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
  const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';

  switch (key) {
    case forward:
      return index < 0 ? 0 : (index + 1) % count;
    case back:
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function stepFocus(event: KeyboardEvent<HTMLElement>, selector: string, axis: Axis, activate = false) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
  const next = stepIndex(event.key, items.indexOf(event.target as HTMLElement), items.length, axis);

  if (next === null) {
    return;
  }

  event.preventDefault();
  items[next].focus();

  if (activate) {
    items[next].click();
  }
}

// Arrow keys of a horizontal tablist: Left/Right move the focus between the
// enabled tabs and select the one reached (automatic activation); Home and
// End jump to the first and the last. The container passes it as onKeyDown;
// the unselected tabs stay out of the Tab order (tabIndex −1).
export function tablistKeyDown(event: KeyboardEvent<HTMLElement>) {
  stepFocus(event, '[role="tab"]:not(:disabled)', 'x', true);
}
