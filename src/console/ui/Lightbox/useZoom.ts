// The stage's pan and zoom wired to the DOM (the rules and the arithmetic:
// zoom.logic.ts). One effect per image: it measures the stage and the
// fitted image, listens to the pointers (on the window while any is down,
// so a drag that leaves the stage goes on), to the wheel (a native
// non-passive listener — React's is passive and could not stop the page
// behind from scrolling or zooming) and to the stage's size, runs the
// double tap's animation on frames, and writes the view straight into the
// image's transform — no render per move. `consumeClick` tells the stage's
// click handler whether the click that follows a pointer was a clean tap
// (a drag or a pinch that ends on the background must not close the
// viewer).

import { useCallback, useEffect, useRef } from 'react';
import { ANIMATION_MS, FIT, ZoomGestures, easeOut, interpolateView, sameView, wheelPixels, wheelZoomFactor } from './zoom.logic.ts';
import type { Geometry, Point, View } from './zoom.logic.ts';

export type ZoomHandles = {
  stageRef: (node: HTMLDivElement | null) => void;
  imgRef: (node: HTMLImageElement | null) => void;
  consumeClick: () => boolean;
};

function measure(stage: HTMLElement, img: HTMLImageElement): Geometry {
  return {
    stage: { width: stage.clientWidth, height: stage.clientHeight },
    image: { width: img.offsetWidth, height: img.offsetHeight },
    center: { x: img.offsetLeft + img.offsetWidth / 2, y: img.offsetTop + img.offsetHeight / 2 },
    natural: img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null,
  };
}

export function useZoom(src: string): ZoomHandles {
  const stage = useRef<HTMLDivElement | null>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const tapped = useRef(false);
  const stageRef = useCallback((node: HTMLDivElement | null) => {
    stage.current = node;
  }, []);
  const imgRef = useCallback((node: HTMLImageElement | null) => {
    img.current = node;
  }, []);
  const consumeClick = useCallback(() => {
    const ok = tapped.current;

    tapped.current = false;

    return ok;
  }, []);

  useEffect(() => {
    const stageEl = stage.current;
    const imgEl = img.current;

    if (!stageEl || !imgEl) {
      return undefined;
    }

    const gestures = new ZoomGestures(measure(stageEl, imgEl));
    let frame = 0;

    const show = (view: View) => {
      imgEl.style.transform = sameView(view, FIT) ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      stageEl.toggleAttribute('data-zoomed', Math.abs(view.scale - 1) > 1e-6);
    };
    const stopAnimation = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const animateTo = (target: View) => {
      const from = gestures.view;
      const started = performance.now();

      stopAnimation();

      const tick = (now: number) => {
        const progress = Math.min(1, (now - started) / ANIMATION_MS);
        const view = interpolateView(from, target, easeOut(progress));

        gestures.setView(view);
        show(view);
        frame = progress < 1 ? requestAnimationFrame(tick) : 0;
      };

      frame = requestAnimationFrame(tick);
    };
    const remeasure = () => show(gestures.setGeometry(measure(stageEl, imgEl)));
    const point = (event: { clientX: number; clientY: number }): Point => {
      const rect = stageEl.getBoundingClientRect();

      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const run = (effects: ReturnType<ZoomGestures['move']>) => {
      for (const effect of effects) {
        if (effect.kind === 'view') {
          show(effect.view);
        } else if (effect.kind === 'animate') {
          animateTo(effect.view);
        } else {
          tapped.current = true;
        }
      }
    };

    const onMove = (event: PointerEvent) => run(gestures.move(event.pointerId, point(event), event.timeStamp));
    const onUp = (event: PointerEvent) => {
      run(gestures.up(event.pointerId, event.timeStamp));

      if (!gestures.active) {
        stageEl.removeAttribute('data-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      }
    };
    const onDown = (event: PointerEvent) => {
      // The arrows and the bar's buttons keep their clicks; a mouse pans with its main button only.
      if ((event.target instanceof Element && event.target.closest('a,button')) || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
      }

      event.preventDefault();
      stopAnimation();
      tapped.current = false;

      if (!gestures.active) {
        remeasure();
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }

      run(gestures.down(event.pointerId, event.pointerType === 'mouse' ? 'mouse' : 'touch', point(event), event.timeStamp));
      stageEl.setAttribute('data-dragging', '');
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stopAnimation();

      const delta = wheelPixels(event);

      show(event.metaKey || event.ctrlKey ? gestures.zoomBy(point(event), wheelZoomFactor(delta.y)) : gestures.pan(-delta.x, -delta.y));
    };
    const observer = new ResizeObserver(remeasure);

    observer.observe(stageEl);
    imgEl.addEventListener('load', remeasure);
    stageEl.addEventListener('pointerdown', onDown);
    stageEl.addEventListener('wheel', onWheel, { passive: false });
    show(FIT);

    return () => {
      stopAnimation();
      observer.disconnect();
      imgEl.removeEventListener('load', remeasure);
      stageEl.removeEventListener('pointerdown', onDown);
      stageEl.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      stageEl.removeAttribute('data-dragging');
      stageEl.removeAttribute('data-zoomed');
      imgEl.style.transform = '';
    };
  }, [src]);

  return { stageRef, imgRef, consumeClick };
}
