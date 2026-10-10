// Bringing the body back to the place a history entry was left at (the
// rule is restoreMove in shell.logic.ts). The place is set before paint
// (the shell's layout effect) and, while the content is not yet tall
// enough — the screen still filling in — again whenever the body's content
// grows, until the place is reached or someone else moves the box: the
// reader, or a screen with its own hand on the scroll (the feed opens at
// the place itself). Stops with the effect that started it.

import { restoreMove } from './shell.logic.ts';

export function restoreScroll(box: HTMLElement, target: number): () => void {
  let lastSet: number | null = null;
  let observer: ResizeObserver | null = null;
  let pending = true;

  const stop = () => {
    pending = false;
    observer?.disconnect();
    observer = null;
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

  if (pending && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(step);

    // The content, not the box: the box keeps its size while its content grows.
    for (const child of Array.from(box.children)) {
      observer.observe(child);
    }
  }

  return stop;
}
