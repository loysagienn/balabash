// The app shell (design: Shell): sidebar with the workspace and sections
// — the main thread first among them, with its shortcut (⌘J / Ctrl+J from
// any screen) — header (ShellTop), the screen's body, bottom tabs and the
// "More" sheet on the phone — one markup, reflowing by the `shell`
// container width. Counts and attention marks come from the store: running
// threads on "Threads", a dot on a section that awaits the user. The
// toasts of the store stack in the corner of the shell (features/toasts).
// The sidebar head names the workspace and, once Settings has it, the
// operator under it.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from '../../lib/router/Link.tsx';
import type { AppRoute, NavKey } from '../../lib/router/routes.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectConnectionsNeedingAction } from '../../store/connections/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectRunningCount } from '../../store/threads/selectors.ts';
import { closeMoreSheet, openMoreSheet } from '../../store/ui/actions.ts';
import { selectMoreSheet } from '../../store/ui/selectors.ts';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Attn, Count, Kbd } from '../../ui/atoms/atoms.tsx';
import { SectionGrid } from '../../ui/SectionGrid/SectionGrid.tsx';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { Toasts } from '../toasts/Toasts.tsx';
import { MORE, NAV, TABS } from './nav.ts';
import { isMainThreadOpen, isMainThreadShortcut, keepsScrollPlace, mainThreadRoute, mainThreadShortcutLabel } from './shell.logic.ts';
import { restoreScroll } from './scroll.ts';
import { ShellTop } from './ShellTop.tsx';
import type { ShellTopProps } from './ShellTop.tsx';
import './Shell.css';

export type ShellProps = Omit<ShellTopProps, 'running' | 'main'> & {
  current: NavKey | null;
  // A detail screen: no bottom tabs on the phone.
  detail?: boolean;
  children: ReactNode;
};

export function Shell({ current, detail, children, ...top }: ShellProps) {
  const dispatch = useAppDispatch();
  const me = useAppSelector(selectMe);
  const running = useAppSelector(selectRunningCount);
  const attention = useAppSelector(selectConnectionsNeedingAction).length > 0 ? new Set<NavKey>(['connections']) : new Set<NavKey>();
  const moreOpen = useAppSelector(selectMoreSheet);
  const route = useAppSelector(state => state.router.route);
  const source = useAppSelector(state => state.router.source);
  const scroll = useAppSelector(state => state.router.scroll);
  const body = useRef<HTMLElement>(null);
  const mainThreadId = me?.mainThreadId ?? null;
  // One route object per id: the key listener below binds once, not per render.
  const mainRoute = useMemo(() => mainThreadRoute(mainThreadId), [mainThreadId]);
  const mainOpen = isMainThreadOpen(route, mainThreadId);
  const main = mainRoute ? { route: mainRoute, current: mainOpen } : null;
  // On the main thread no section is current: it has its own item.
  const section = mainOpen ? null : current;

  // A new screen starts at the top; a move inside the same page
  // (keepsScrollPlace) keeps its place; a history navigation brings back
  // the place the entry was left at (restoreScroll: now, and again as the
  // screen grows into it, until the reader or the screen moves the body
  // itself). Before paint, so the body never shows at the top first.
  const previous = useRef<AppRoute | null>(null);

  useLayoutEffect(() => {
    const from = previous.current;
    const box = body.current;

    previous.current = route;

    if (!box) {
      return undefined;
    }

    if (source === 'history' && scroll !== null) {
      return restoreScroll(box, scroll);
    }

    if (!(from && keepsScrollPlace(from, route))) {
      box.scrollTop = 0;
    }

    return undefined;
  }, [route, source, scroll]);

  // ⌘J / Ctrl+J opens the main thread from any screen (on the main thread
  // itself ROUTE_TO is a no-op: the route is the same).
  useEffect(() => {
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
  }, [mainRoute, dispatch]);

  const workspace = me?.workspaceName ?? 'Workspace';
  const operator = me?.operatorName ?? null;
  const tabCurrent = section === null ? null : TABS.some(item => item.key === section) ? section : 'more';
  const moreAttention = MORE.some(item => attention.has(item.key));

  return (
    <div className="app">
      <div className="shell" data-detail={detail ? '' : undefined}>
        <aside className="shell-side">
          <div className="shell-ws">
            <div className="shell-logo">{workspace.charAt(0).toUpperCase()}</div>
            <div>
              <b className="shell-ws-name">{workspace}</b>
              {operator ? <small className="shell-ws-sub">{operator}</small> : null}
            </div>
          </div>
          <nav className="shell-nav" aria-label="Sections">
            {main ? (
              <Link className="shell-nav-i shell-mt" route={main.route} current={main.current}>
                <Icon name="message-circle" />
                Main thread
                <span className="shell-nav-end">
                  <Kbd>{mainThreadShortcutLabel(navigator.platform)}</Kbd>
                </span>
              </Link>
            ) : null}
            {NAV.map(item => (
              <Link key={item.key} className="shell-nav-i" route={item.route} current={item.key === section}>
                <Icon name={item.icon} />
                {item.name}
                {item.key === 'threads' && running > 0 ? (
                  <span className="shell-nav-end">
                    <Count state="run">{running}</Count>
                  </span>
                ) : attention.has(item.key) ? (
                  <span className="shell-nav-end">
                    <Attn />
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="shell-main">
          <ShellTop {...top} running={running} main={main} />
          <main className="shell-body" ref={body}>
            {children}
          </main>
          <nav className="shell-tabs" aria-label="Sections">
            {TABS.map(item => (
              <Link key={item.key} className="shell-tab" route={item.route} current={item.key === tabCurrent}>
                <Icon name={item.icon} />
                {item.name}
                {item.key === 'threads' && running > 0 ? (
                  <Count state="run" size="sm" className="shell-tab-badge">
                    {running}
                  </Count>
                ) : null}
              </Link>
            ))}
            <a
              className="shell-tab"
              href="#more"
              aria-current={tabCurrent === 'more' ? 'page' : undefined}
              aria-expanded={moreOpen}
              onClick={event => {
                event.preventDefault();
                dispatch(moreOpen ? closeMoreSheet() : openMoreSheet());
              }}
            >
              <Icon name="ellipsis" />
              More
              {moreAttention ? <Attn className="shell-tab-badge" /> : null}
            </a>
          </nav>
        </div>
      </div>
      <Toasts tabs={!detail} />
      {moreOpen ? (
        <Sheet label="More sections" onClose={() => dispatch(closeMoreSheet())}>
          <SectionGrid label="More sections">
            {MORE.map(item => (
              <Link key={item.key} className="secgrid-i" route={item.route} current={item.key === section}>
                <Icon name={item.icon} />
                {item.name}
                {attention.has(item.key) ? <Attn className="secgrid-badge" /> : null}
              </Link>
            ))}
          </SectionGrid>
        </Sheet>
      ) : null}
    </div>
  );
}

export type { AppRoute };
