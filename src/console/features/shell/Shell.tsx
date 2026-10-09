// The app shell (design: Shell): sidebar with the workspace and sections,
// header (ShellTop), the screen's body, bottom tabs and the "More" sheet on
// the phone — one markup, reflowing by the `shell` container width. Counts
// and attention marks come from the store: running threads on "Threads",
// a dot on a section that awaits the user. The toasts of the store stack
// in the corner of the shell (features/toasts).

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from '../../lib/router/Link.tsx';
import type { AppRoute, NavKey } from '../../lib/router/routes.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectConnectionsNeedingAction } from '../../store/connections/selectors.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectRunningCount } from '../../store/threads/selectors.ts';
import { closeMoreSheet, openMoreSheet } from '../../store/ui/actions.ts';
import { selectMoreSheet } from '../../store/ui/selectors.ts';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Attn, Count } from '../../ui/atoms/atoms.tsx';
import { SectionGrid } from '../../ui/SectionGrid/SectionGrid.tsx';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { Toasts } from '../toasts/Toasts.tsx';
import { MORE, NAV, TABS } from './nav.ts';
import { ShellTop } from './ShellTop.tsx';
import type { ShellTopProps } from './ShellTop.tsx';
import './Shell.css';

export type ShellProps = Omit<ShellTopProps, 'running'> & {
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
  const body = useRef<HTMLElement>(null);

  // A new screen starts at the top; history navigation keeps its place.
  useEffect(() => {
    if (source === 'app' && body.current) {
      body.current.scrollTop = 0;
    }
  }, [route, source]);

  const tabCurrent = TABS.some(item => item.key === current) ? current : 'more';
  const moreAttention = MORE.some(item => attention.has(item.key));

  return (
    <div className="app">
      <div className="shell" data-detail={detail ? '' : undefined}>
        <aside className="shell-side">
          <div className="shell-ws">
            <div className="shell-logo">B</div>
            <div>
              <b className="shell-ws-name">{me?.workspaceName ?? 'Workspace'}</b>
              <small className="shell-ws-sub">Balabash</small>
            </div>
          </div>
          <nav className="shell-nav" aria-label="Sections">
            {NAV.map(item => (
              <Link key={item.key} className="shell-nav-i" route={item.route} current={item.key === current}>
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
          <ShellTop {...top} running={running} />
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
              <Link key={item.key} className="secgrid-i" route={item.route} current={item.key === current}>
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
