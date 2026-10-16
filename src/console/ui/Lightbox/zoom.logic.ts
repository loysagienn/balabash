// The arithmetic of the image viewer's pan and zoom and the one place that
// turns pointers into it (Vladimir's brief, 86241): the mechanics of a
// canvas. The view is the image's departure from the fitted picture the
// stage lays out — `scale` relative to the fitted size (1 — as fitted),
// `x`/`y` — how far the image's center moved from its laid-out place, in
// stage pixels — so the fitted view is the identity and the stage keeps
// its own layout. Every point here is in stage coordinates (from the
// stage's top-left corner).
//
// Desktop: the wheel pans, ⌘/Ctrl + wheel zooms about the cursor (a
// trackpad pinch reaches the page as Ctrl + wheel). Touch: one finger pans;
// two fingers pinch — the image point under their midpoint stays under it
// as they move; a finger lifted or added re-bases the gesture from the
// view of that moment, so 2 → 1 → 2 never jumps; a double tap zooms into
// its point with an animation (or back to the fit from any other view); a
// double tap whose second touch stays down enters the one-finger zoom:
// down — in, up — out, about the point of the tap. A mouse drag pans, a
// double click is a double tap.
//
// The clamp: the scale between half the fit and the maximum (4× the fit or
// 2× the natural pixels, whichever is more); the image can be dragged past the
// stage's edge by at most half of the stage (Vladimir: "within half the
// screen's width/height"), that is its center travels between the stage's
// center minus and plus its own half-size — an interval widened to hold
// the laid-out center too, so the fit is always a legal view.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type View = { scale: number; x: number; y: number };
export type Geometry = {
  // The stage box the pointers are measured in.
  stage: Size;
  // The image as laid out at the fit and where its center lies.
  image: Size;
  center: Point;
  // The natural pixels, once the image has loaded.
  natural: Size | null;
};

export const FIT: View = { scale: 1, x: 0, y: 0 };
// Half the fit at the smallest (Vladimir: "up to two times smaller than the default").
export const MIN_SCALE = 0.5;
// A double tap zooms to this scale (bounded by the maximum).
export const DOUBLE_TAP_SCALE = 2.5;
// The one-finger zoom doubles the scale every this many pixels downward.
export const ZOOM_DRAG_PX = 120;
// A second tap within this time and distance of the first is a double tap.
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;
// A pointer that stayed within the slop of where it went down has tapped.
export const TOUCH_SLOP_PX = 8;
export const MOUSE_SLOP_PX = 3;
// The time of the double tap's animation.
export const ANIMATION_MS = 240;

const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
const WHEEL_ZOOM_CAP_PX = 40;
const WHEEL_ZOOM_RATE = 0.01;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function maxScale(geometry: Geometry): number {
  const native = geometry.natural && geometry.image.width > 0 ? geometry.natural.width / geometry.image.width : 1;

  return Math.max(4, native * 2);
}

function clampAxis(laidOut: number, half: number, stage: number, offset: number): number {
  const low = Math.min(laidOut, stage / 2 - half);
  const high = Math.max(laidOut, stage / 2 + half);

  return clamp(laidOut + offset, low, high) - laidOut;
}

// The view within its bounds; the scale first — a scale pushed back to the
// fit lets no offset through.
export function clampView(view: View, geometry: Geometry): View {
  const scale = clamp(view.scale, MIN_SCALE, maxScale(geometry));

  return {
    scale,
    x: clampAxis(geometry.center.x, (geometry.image.width * scale) / 2, geometry.stage.width, view.x),
    y: clampAxis(geometry.center.y, (geometry.image.height * scale) / 2, geometry.stage.height, view.y),
  };
}

// Where the image's center is in this view.
export function imageCenter(view: View, geometry: Geometry): Point {
  return { x: geometry.center.x + view.x, y: geometry.center.y + view.y };
}

// The view's scale multiplied by `factor` with the image point under
// `point` staying under it (the clamp of the edges allowing).
export function zoomAt(view: View, point: Point, factor: number, geometry: Geometry): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, maxScale(geometry));
  const k = scale / view.scale;
  const center = imageCenter(view, geometry);

  return clampView(
    {
      scale,
      x: point.x + (center.x - point.x) * k - geometry.center.x,
      y: point.y + (center.y - point.y) * k - geometry.center.y,
    },
    geometry,
  );
}

export function panBy(view: View, dx: number, dy: number, geometry: Geometry): View {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, geometry);
}

// Two fingers: the base is the view, the midpoint and the distance when
// the pinch began (or was re-based); the image point that was under the
// midpoint then stays under the midpoint now.
export type PinchBase = { view: View; mid: Point; dist: number };

export function pinchView(base: PinchBase, mid: Point, dist: number, geometry: Geometry): View {
  const scale = clamp(base.view.scale * (base.dist > 0 ? dist / base.dist : 1), MIN_SCALE, maxScale(geometry));
  const center = imageCenter(base.view, geometry);
  const ux = (base.mid.x - center.x) / base.view.scale;
  const uy = (base.mid.y - center.y) / base.view.scale;

  return clampView({ scale, x: mid.x - ux * scale - geometry.center.x, y: mid.y - uy * scale - geometry.center.y }, geometry);
}

// The one-finger zoom: `dy` pixels travelled since it began (down is
// positive), about the point of the tap, from the view of the start.
export function zoomDragView(base: { view: View; anchor: Point }, dy: number, geometry: Geometry): View {
  return zoomAt(base.view, base.anchor, Math.pow(2, dy / ZOOM_DRAG_PX), geometry);
}

// Where a double tap takes the view: from the fit — into its point, to
// DOUBLE_TAP_SCALE; from any other view (zoomed in or out, or merely
// dragged) — back to the fit (Vladimir, 86241 thread).
export function doubleTapTarget(view: View, point: Point, geometry: Geometry): View {
  if (!sameView(view, FIT)) {
    return FIT;
  }

  return zoomAt(view, point, Math.min(DOUBLE_TAP_SCALE, maxScale(geometry)) / view.scale, geometry);
}

// A wheel event's deltas in pixels, whatever its deltaMode (0 — pixels,
// 1 — lines, 2 — pages); Shift turns a vertical wheel horizontal when
// the browser has not done it already.
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode: number; shiftKey?: boolean }): Point {
  const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const dx = event.deltaX * unit;
  const dy = event.deltaY * unit;

  return event.shiftKey && dx === 0 ? { x: dy, y: 0 } : { x: dx, y: dy };
}

// The zoom factor of one wheel step: a wheel away (deltaY > 0) zooms out, a
// wheel toward zooms in; a notch of a mouse wheel is capped so one notch is
// ×1.5, a trackpad's fine steps stay fine.
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -WHEEL_ZOOM_CAP_PX, WHEEL_ZOOM_CAP_PX) * WHEEL_ZOOM_RATE);
}

// The view between two views, `progress` 0…1: the scale geometrically, the
// offset linearly — the zoom reads as even.
export function interpolateView(from: View, to: View, progress: number): View {
  const p = clamp(progress, 0, 1);

  return {
    scale: from.scale * Math.pow(to.scale / from.scale, p),
    x: from.x + (to.x - from.x) * p,
    y: from.y + (to.y - from.y) * p,
  };
}

export function easeOut(progress: number): number {
  return 1 - Math.pow(1 - clamp(progress, 0, 1), 3);
}

export function sameView(a: View, b: View): boolean {
  return Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

// ── The pointers ──

export type PointerKind = 'touch' | 'mouse';

export type GestureEffect =
  // The view to show right now.
  | { kind: 'view'; view: View }
  // The view to animate to (a double tap).
  | { kind: 'animate'; view: View }
  // A clean single tap — the pointer went down and up without moving and
  // without company; the owner may treat the click that follows as a click.
  | { kind: 'tap'; point: Point };

type Tracked = { id: number; kind: PointerKind; at: Point; down: Point; downAt: number; moved: boolean };

type Mode =
  // One pointer panning (or about to tap).
  | { kind: 'pan' }
  // Two or more pointers pinching from the base.
  | { kind: 'pinch'; base: PinchBase }
  // The second touch of a double tap, still down: a release without
  // movement is the double tap; movement past the slop is the one-finger
  // zoom about the tap's point.
  | { kind: 'second-tap'; anchor: Point; drag: { view: View; fromY: number } | null };

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The pointers of one stage turned into views. The owner feeds every
 * pointerdown/move/up (cancel counts as up) with the pointer's id, kind and
 * stage coordinates and the time, applies the effects, keeps `view` current
 * through setView while animating, and tells it the geometry when the stage
 * or the image changes.
 */
export class ZoomGestures {
  private pointers: Tracked[] = [];
  private mode: Mode | null = null;
  // Whether the session that is down had more than one pointer at any
  // time: such a session is never a tap.
  private crowded = false;
  private lastTap: { point: Point; at: number } | null = null;
  private geometry: Geometry;
  view: View;

  constructor(geometry: Geometry, view: View = FIT) {
    this.geometry = geometry;
    this.view = view;
  }

  get active(): boolean {
    return this.pointers.length > 0;
  }

  setView(view: View): void {
    this.view = view;
  }

  // A new geometry keeps the view within the new bounds.
  setGeometry(geometry: Geometry): View {
    this.geometry = geometry;
    this.view = clampView(this.view, geometry);

    return this.view;
  }

  reset(): void {
    this.pointers = [];
    this.mode = null;
    this.crowded = false;
    this.lastTap = null;
    this.view = FIT;
  }

  // The wheel: a step of the pan, or of the zoom about the cursor.
  pan(dx: number, dy: number): View {
    this.view = panBy(this.view, dx, dy, this.geometry);

    return this.view;
  }

  zoomBy(point: Point, factor: number): View {
    this.view = zoomAt(this.view, point, factor, this.geometry);

    return this.view;
  }

  down(id: number, kind: PointerKind, at: Point, time: number): GestureEffect[] {
    if (this.pointers.some(p => p.id === id)) {
      return [];
    }

    this.pointers.push({ id, kind, at, down: at, downAt: time, moved: false });

    if (this.pointers.length === 1) {
      this.crowded = false;

      const second = this.lastTap && time - this.lastTap.at <= DOUBLE_TAP_MS && distance(at, this.lastTap.point) <= DOUBLE_TAP_PX;

      this.mode = second ? { kind: 'second-tap', anchor: at, drag: null } : { kind: 'pan' };
      this.lastTap = null;
    } else {
      this.crowded = true;
      this.lastTap = null;
      this.rebase();
    }

    return [];
  }

  move(id: number, at: Point, time: number): GestureEffect[] {
    void time;

    const pointer = this.pointers.find(p => p.id === id);

    if (!pointer || !this.mode) {
      return [];
    }

    const previous = pointer.at;

    pointer.at = at;

    if (!pointer.moved && distance(at, pointer.down) > (pointer.kind === 'touch' ? TOUCH_SLOP_PX : MOUSE_SLOP_PX)) {
      pointer.moved = true;
    }

    if (this.mode.kind === 'pinch') {
      const [a, b] = this.pointers;

      if (id !== a.id && id !== b.id) {
        return [];
      }

      this.view = pinchView(this.mode.base, midpoint(a.at, b.at), distance(a.at, b.at), this.geometry);

      return [{ kind: 'view', view: this.view }];
    }

    if (this.mode.kind === 'second-tap') {
      if (this.mode.drag) {
        this.view = zoomDragView({ view: this.mode.drag.view, anchor: this.mode.anchor }, at.y - this.mode.drag.fromY, this.geometry);

        return [{ kind: 'view', view: this.view }];
      }

      if (pointer.moved) {
        this.mode.drag = { view: this.view, fromY: at.y };
      }

      return [];
    }

    // pan: the image follows the finger step by step (a clamp that eats a
    // step does not accumulate a debt).
    const next = panBy(this.view, at.x - previous.x, at.y - previous.y, this.geometry);

    if (sameView(next, this.view)) {
      return [];
    }

    this.view = next;

    return [{ kind: 'view', view: this.view }];
  }

  up(id: number, time: number): GestureEffect[] {
    const pointer = this.pointers.find(p => p.id === id);

    if (!pointer) {
      return [];
    }

    this.pointers = this.pointers.filter(p => p.id !== id);

    if (this.pointers.length > 0) {
      this.rebase();

      return [];
    }

    const mode = this.mode;

    this.mode = null;

    if (!mode || this.crowded) {
      return [];
    }

    if (mode.kind === 'second-tap') {
      return mode.drag || pointer.moved ? [] : [{ kind: 'animate', view: doubleTapTarget(this.view, mode.anchor, this.geometry) }];
    }

    if (mode.kind === 'pan' && !pointer.moved) {
      this.lastTap = { point: pointer.down, at: time };

      return [{ kind: 'tap', point: pointer.down }];
    }

    return [];
  }

  // The pointers that remain begin anew from the view of this moment: two
  // or more — a pinch about their midpoint, one — a pan from where it is.
  private rebase(): void {
    if (this.pointers.length >= 2) {
      const [a, b] = this.pointers;

      this.mode = { kind: 'pinch', base: { view: this.view, mid: midpoint(a.at, b.at), dist: distance(a.at, b.at) } };
    } else {
      this.mode = { kind: 'pan' };
    }
  }
}
