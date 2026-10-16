// The stage: the pages of the navigation on the screen (the rules:
// stage.logic.ts). The store's router says which page is current; the
// stage keeps it as a layer and, on the phone, keeps the page it replaces
// for the time of a slide — a nested page slides in over the page it was
// opened from and slides out to the right when the user goes back, by the
// header's arrow, the browser's back or a swipe (useSwipeBack.ts: the
// finger moves the page, the parent shows beneath). Every layer gets its
// own ScreenNav (lib/router/screen): the route of its page and what the
// navigation does to its scroll — a leaving page never learns of the
// route it leaves for. The places the pages were left at are the stage's
// memory, by history entry (the shell gives its scroller): a history
// move brings the place back, a swipe back opens the parent already at
// its place. The toasts, the image viewer and the "add workspace" window
// are here once, over every layer; so is the main thread's shortcut.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ScreenNavProvider } from '../../lib/router/screen.tsx';
import type { ScreenNav } from '../../lib/router/screen.tsx';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { goBack, routeTo } from '../../store/router/actions.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { Toasts } from '../../features/toasts/Toasts.tsx';
import { ImageViewer } from '../../features/viewer/ImageViewer.tsx';
import { AddWorkspaceDialog } from '../../features/workspaces/Workspaces.tsx';
import { isMainThreadShortcut, mainThreadRoute } from '../../features/shell/shell.logic.ts';
import { screenOf } from './screens.tsx';
import {
  canSwipe,
  initialStage,
  onAnimDone,
  onGestureCancel,
  onGestureEnd,
  onGestureMove,
  onGestureStart,
  onNav,
} from './stage.logic.ts';
import type { StageEnv, StageLayer, StageState } from './stage.logic.ts';
import { clearMotion, paintMotion, runMotion } from './stageMotion.ts';
import type { MotionElements } from './stageMotion.ts';
import { installSwipeBack } from './useSwipeBack.ts';
import './Stage.css';

// The phone: the shell's narrow layout (Shell.css, the `shell` container ≤ 720).
export const PHONE_SHELL_MAX = 720;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// The width of the stage and the user's wish about motion, live.
function useStageEnv(root: { current: HTMLElement | null }): StageEnv {
  const [env, setEnv] = useState<StageEnv>(() => ({
    phone: false,
    reduced: typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches,
  }));

  useLayoutEffect(() => {
    const element = root.current;

    if (!element) {
      return undefined;
    }

    const reduced = matchMedia(REDUCED_MOTION);
    const read = () => {
      const next = { phone: element.clientWidth <= PHONE_SHELL_MAX, reduced: reduced.matches };

      setEnv(env => (env.phone === next.phone && env.reduced === next.reduced ? env : next));
    };
    const observer = new ResizeObserver(read);

    observer.observe(element);
    reduced.addEventListener('change', read);
    read();

    return () => {
      observer.disconnect();
      reduced.removeEventListener('change', read);
    };
  }, [root]);

  return env;
}

export function Stage() {
  const dispatch = useAppDispatch();
  const router = useAppSelector(state => state.router);
  const me = useAppSelector(selectMe);
  const root = useRef<HTMLDivElement>(null);
  const env = useStageEnv(root);
  const envRef = useRef(env);
  const [state, setState] = useState(() => initialStage(router));
  // The state as of the last step — the pointer's handlers step it between renders.
  const stateRef = useRef(state);
  // The scrollers of the mounted pages, by page; the places left, by entry.
  const frames = useRef(new Map<number, HTMLElement>());
  const places = useRef(new Map<number, number>());
  const layers = useRef(new Map<number, HTMLDivElement>());
  const dims = useRef(new Map<number, HTMLDivElement>());
  // Whether the current page is a detail (the shell's word): the toasts sit lower without tabs.
  const details = useRef(new Map<number, boolean>());
  const [detail, setDetail] = useState(false);

  envRef.current = env;

  const commit = useCallback((next: StageState) => {
    stateRef.current = next;
    setState(next);
    setDetail(details.current.get(next.current) ?? false);
  }, []);

  const keepPlaces = () => {
    for (const layer of stateRef.current.layers) {
      const frame = frames.current.get(layer.page);

      if (frame && layer.entry !== null) {
        places.current.set(layer.entry, frame.scrollTop);
      }
    }
  };
  const place = (entry: number) => places.current.get(entry) ?? null;

  // A navigation: the places of the pages on the screen are kept first,
  // then the stage takes its step. Before paint: the new page never shows
  // a frame late.
  const seen = useRef(router);

  useLayoutEffect(() => {
    if (router === seen.current) {
      return;
    }

    seen.current = router;
    keepPlaces();
    commit(onNav(stateRef.current, { router, env: envRef.current, place }));
  });

  const elementsOf = (): MotionElements => {
    const motion = stateRef.current.motion;

    return motion
      ? {
          top: layers.current.get(motion.top) ?? null,
          under: layers.current.get(motion.under) ?? null,
          dim: dims.current.get(motion.under) ?? null,
        }
      : { top: null, under: null, dim: null };
  };

  // The motion drawn (stageMotion.ts); the finger's moves are painted by
  // the gesture itself, between renders.
  const motion = state.motion;

  useLayoutEffect(() => {
    if (!motion) {
      for (const layer of layers.current.values()) {
        clearMotion({ top: layer, under: null, dim: null });
      }

      return undefined;
    }

    return runMotion(motion, elementsOf(), () => commit(onAnimDone(stateRef.current)));
  }, [motion, commit]);

  // The swipe back (useSwipeBack.ts).
  useEffect(() => {
    const element = root.current;

    if (!element) {
      return undefined;
    }

    return installSwipeBack(element, {
      canStart: target => {
        const current = layers.current.get(stateRef.current.current);

        return !!current && current.contains(target) && canSwipe(stateRef.current, envRef.current);
      },
      start: () => {
        const next = onGestureStart(stateRef.current, { router: seen.current, env: envRef.current, place });

        if (next === stateRef.current) {
          return false;
        }

        // The parent mounts under the finger now, not at the next frame.
        flushSync(() => commit(next));

        return true;
      },
      move: offset => {
        stateRef.current = onGestureMove(stateRef.current, offset);

        if (stateRef.current.motion) {
          paintMotion(elementsOf(), stateRef.current.motion.offset);
        }
      },
      end: (velocity, width) => {
        const step = onGestureEnd(stateRef.current, velocity, width, envRef.current);

        commit(step.state);

        for (const effect of step.effects) {
          dispatch(goBack(effect.fallback));
        }
      },
      cancel: () => commit(onGestureCancel(stateRef.current, envRef.current)),
    });
  }, [commit, dispatch]);

  // ⌘J / Ctrl+J opens the main thread from any screen (on the main thread
  // itself ROUTE_TO is a no-op: the route is the same).
  const mainThreadId = me?.mainThreadId ?? null;

  useEffect(() => {
    const mainRoute = mainThreadRoute(mainThreadId);

    if (!mainRoute) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent) => {
      if (isMainThreadShortcut(event)) {
        event.preventDefault();
        dispatch(routeTo(mainRoute));
      }
    };

    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, [mainThreadId, dispatch]);

  const registerFrame = useCallback((page: number, element: HTMLElement | null) => {
    if (element) {
      frames.current.set(page, element);
    } else {
      frames.current.delete(page);
    }
  }, []);
  const reportDetail = useCallback((page: number, value: boolean) => {
    details.current.set(page, value);

    if (page === stateRef.current.current) {
      setDetail(value);
    }
  }, []);

  return (
    <div ref={root} className="app" data-motion={motion ? '' : undefined}>
      {state.layers.map(layer => {
        const role = motion ? (layer.page === motion.top ? 'top' : 'under') : 'current';
        const current = layer.page === state.current;

        return (
          <div
            key={layer.page}
            ref={element => {
              if (element) {
                layers.current.set(layer.page, element);
              } else {
                layers.current.delete(layer.page);
                dims.current.delete(layer.page);
              }
            }}
            className="stage-layer"
            data-role={role}
            inert={current ? undefined : true}
          >
            <Page layer={layer} current={current} registerFrame={registerFrame} reportDetail={reportDetail} />
            {role === 'under' ? (
              <div
                className="stage-dim"
                ref={element => {
                  if (element) {
                    dims.current.set(layer.page, element);
                  }
                }}
              />
            ) : null}
          </div>
        );
      })}
      <Toasts tabs={!detail} />
      <ImageViewer />
      <AddWorkspaceDialog />
    </div>
  );
}

type PageProps = {
  layer: StageLayer;
  current: boolean;
  registerFrame: (page: number, element: HTMLElement | null) => void;
  reportDetail: (page: number, detail: boolean) => void;
};

// One page: its screen under its own ScreenNav. Memoized on the layer —
// a finger's moves and the motion's steps do not render the screens.
const Page = memo(function Page({ layer, current, registerFrame, reportDetail }: PageProps): ReactNode {
  const frame = useCallback(
    (element: HTMLElement | null) => registerFrame(layer.page, element),
    [registerFrame, layer.page],
  );
  const setDetail = useCallback((detail: boolean) => reportDetail(layer.page, detail), [reportDetail, layer.page]);
  const nav: ScreenNav = {
    page: layer.page,
    route: layer.route,
    hash: layer.hash,
    move: layer.move,
    nav: layer.nav,
    scroll: layer.scroll,
    current,
    frame,
    setDetail,
  };

  return <ScreenNavProvider value={nav}>{screenOf(layer.route)}</ScreenNavProvider>;
});
