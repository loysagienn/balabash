// Bringing the body back to the place a history entry was left at (the
// rule is restoreMove in shell.logic.ts). The place is set before paint
// (the shell's layout effect) and, while the content is not yet tall
// enough — the screen still filling in — again whenever the body's content
// grows, until the place is reached or someone else moves the box: the
// reader, or a screen with its own hand on the scroll (the feed opens at
// the place itself). A foreign move cancels the restoration the moment
// the box reports it (its scroll event), not at the next growth: a reader
// who scrolled away and came back to the very place the last step set
// has taken the scroll, and the content growing later must not move them.
// The box reports the controller's own steps too — at the place the step
// set, which is no move. Stops with the effect that started it.

import { restoreMove } from './shell.logic.ts';

// What the controller needs of the body: the scroll place, the sizes that
// bound it, the children whose growth is watched, and the scroll event.
export type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'children' | 'addEventListener' | 'removeEventListener'>;

// Within a pixel (a box reports fractions) — the same comparison restoreMove makes.
function movedFrom(lastSet: number | null, scrollTop: number): boolean {
  return lastSet !== null && Math.abs(scrollTop - lastSet) > 1;
}

export function restoreScroll(box: ScrollBox, target: number): () => void {
  let lastSet: number | null = null;
  let observer: ResizeObserver | null = null;
  let pending = true;

  const onScroll = () => {
    if (pending && movedFrom(lastSet, box.scrollTop)) {
      stop();
    }
  };

  const stop = () => {
    pending = false;
    observer?.disconnect();
    observer = null;
    box.removeEventListener('scroll', onScroll);
  };

  const step = () => {
    if (!pending) {
      return;
    }

    const move = restoreMove({ target, lastSet, scrollTop: box.scrollTop, maxScroll: box.scrollHeight - box.clientHeight });

    if (move === null) {
      stop();
      return;
    }

    box.scrollTop = move.to;
    lastSet = box.scrollTop;

    if (move.done) {
      stop();
    }
  };

  step();

  if (!pending) {
    return stop;
  }

  box.addEventListener('scroll', onScroll, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(step);

    // The content, not the box: the box keeps its size while its content grows.
    for (const child of Array.from(box.children)) {
      observer.observe(child);
    }
  }

  return stop;
}
