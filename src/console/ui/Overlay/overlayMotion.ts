// The ways a floating window comes and goes (design rule 10: 320 ms for a
// sheet and a modal): a sheet rises from the bottom edge and sinks back; a
// modal fades in, a touch smaller, and fades out; the scrim fades with
// either. A sheet let go by a finger (useSheetDrag) sinks from where the
// finger left it, at the finger's pace. Web Animations, so a window that
// mounts and lays out meanwhile does not stutter them; under reduced
// motion there is none — the window is just there, or gone.

export type OverlayMotion = 'sheet' | 'modal' | 'none';

// Where an exit starts: the window's offset toward gone (0…1 of its own
// way) and the time to take from there.
export type ExitFrom = { offset: number; duration: number };

export const WINDOW_MS = 320;
const EASE = 'cubic-bezier(.2,0,0,1)';
const EASE_OUT = 'cubic-bezier(0,0,.2,1)';
const MODAL_SCALE = 0.96;

export type Run = { finished: Promise<void>; cancel: () => void };

const NONE: Run = { finished: Promise.resolve(), cancel: () => {} };

function run(animations: Animation[]): Run {
  if (animations.length === 0) {
    return NONE;
  }

  const finished = Promise.all(animations.map(animation => animation.finished)).then(
    () => {},
    () => {},
  );

  return { finished, cancel: () => animations.forEach(animation => animation.cancel()) };
}

function windowFrames(kind: OverlayMotion, offset: number): Keyframe {
  return kind === 'sheet'
    ? { transform: `translateY(${offset * 100}%)` }
    : { opacity: 1 - offset, transform: `scale(${1 - (1 - MODAL_SCALE) * offset})` };
}

export function enter(
  kind: OverlayMotion,
  window_: HTMLElement | null,
  scrim: HTMLElement | null,
  reduced: boolean,
): Run {
  if (kind === 'none' || reduced) {
    return NONE;
  }

  const options: KeyframeAnimationOptions = { duration: WINDOW_MS, easing: EASE };
  const animations: Animation[] = [];

  if (window_) {
    animations.push(window_.animate([windowFrames(kind, 1), windowFrames(kind, 0)], options));
  }

  if (scrim) {
    animations.push(scrim.animate([{ opacity: 0 }, { opacity: 1 }], options));
  }

  return run(animations);
}

// The exit keeps its last frame: the window stays gone until it is removed.
export function exit(
  kind: OverlayMotion,
  window_: HTMLElement | null,
  scrim: HTMLElement | null,
  from: ExitFrom | null,
  reduced: boolean,
): Run {
  if (kind === 'none' || reduced) {
    return NONE;
  }

  const offset = from?.offset ?? 0;
  const options: KeyframeAnimationOptions = {
    duration: from?.duration ?? WINDOW_MS,
    easing: from ? EASE_OUT : EASE,
    fill: 'forwards',
  };
  const animations: Animation[] = [];

  if (window_) {
    animations.push(window_.animate([windowFrames(kind, offset), windowFrames(kind, 1)], options));
  }

  if (scrim) {
    animations.push(scrim.animate([{ opacity: 1 - offset }, { opacity: 0 }], options));
  }

  return run(animations);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
