// Drawing a motion of the stage (the rules: stage.logic.ts). The page on
// top moves by its offset — translateX of its own width; the page beneath
// follows a little (the parallax) under a dim that lifts as the top page
// leaves. A finger's moves are painted straight into the styles; a way to
// the target runs as a Web Animation on the compositor — the page sliding
// in is mounting and loading in the meantime, and the main thread's
// business must not stutter the slide — and the styles are painted at
// the target before the animation is let go (a filled animation cancelled
// first would flash the start). Only transform and opacity move.

import { dimAt, parallaxAt } from './stage.logic.ts';
import type { Motion } from './stage.logic.ts';

export type MotionElements = { top: HTMLElement | null; under: HTMLElement | null; dim: HTMLElement | null };

// The design's curves (tokens.css --ease, --ease-out).
const EASE_SLIDE = 'cubic-bezier(.2,0,0,1)';
const EASE_SETTLE = 'cubic-bezier(0,0,.2,1)';

const topTransform = (offset: number) => `translateX(${offset * 100}%)`;
const underTransform = (offset: number) => `translateX(${parallaxAt(offset) * 100}%)`;

function stop(element: HTMLElement | null): void {
  if (element) {
    for (const animation of element.getAnimations()) {
      animation.cancel();
    }
  }
}

export function paintMotion({ top, under, dim }: MotionElements, offset: number): void {
  if (top) {
    top.style.transform = topTransform(offset);
  }

  if (under) {
    under.style.transform = underTransform(offset);
  }

  if (dim) {
    dim.style.opacity = `${dimAt(offset)}`;
  }
}

export function clearMotion({ top, under, dim }: MotionElements): void {
  for (const element of [top, under, dim]) {
    stop(element);

    if (element) {
      element.style.transform = '';
      element.style.opacity = '';
    }
  }
}

export type MotionRun = {
  // The animation let go without a word.
  stop: () => void;
  // The animation is with the compositor (its first frame no longer waits
  // on the main thread's work): what the motion asks of the store — the
  // step back, which renders two pages — goes after this.
  ready: Promise<void>;
};

const AT_ONCE: MotionRun = { stop: () => {}, ready: Promise.resolve() };

// Runs the motion on its elements; `onDone` when an animated way reaches
// the target.
export function runMotion(motion: Motion, elements: MotionElements, onDone: () => void): MotionRun {
  const { top, under, dim } = elements;

  stop(top);
  stop(under);
  stop(dim);

  if (motion.driver === 'gesture') {
    paintMotion(elements, motion.offset);

    return AT_ONCE;
  }

  if (motion.driver === 'done' || motion.duration === 0 || motion.offset === motion.target || !top) {
    paintMotion(elements, motion.target);

    if (motion.driver === 'anim') {
      onDone();
    }

    return AT_ONCE;
  }

  const options: KeyframeAnimationOptions = {
    duration: motion.duration,
    easing: motion.ease === 'slide' ? EASE_SLIDE : EASE_SETTLE,
    fill: 'forwards',
  };
  const animations = [
    top.animate([{ transform: topTransform(motion.offset) }, { transform: topTransform(motion.target) }], options),
    under?.animate(
      [{ transform: underTransform(motion.offset) }, { transform: underTransform(motion.target) }],
      options,
    ),
    dim?.animate([{ opacity: dimAt(motion.offset) }, { opacity: dimAt(motion.target) }], options),
  ].filter((animation): animation is Animation => animation !== undefined);
  let live = true;

  animations[0]!.finished.then(
    () => {
      if (!live) {
        return;
      }

      paintMotion(elements, motion.target);

      for (const animation of animations) {
        animation.cancel();
      }

      onDone();
    },
    () => {},
  );

  return {
    stop: () => {
      live = false;

      for (const animation of animations) {
        animation.cancel();
      }
    },
    ready: animations[0]!.ready.then(
      () => {},
      () => {},
    ),
  };
}
