// The app shell (design: Shell): sidebar with the workspace and sections
// — the main thread first among them, with its shortcut (⌘J / Ctrl+J from
// any screen, the stage's listener) — and the frame: header (ShellTop), the
// screen's body and the phone's tabs in one scroller (.shell-frame), the
// header glass the content passes under (ui/Glass), sticky and in the
// flow; the tabs are islands (ui/Island) floating over the content in a
// sticky field of their own — the capsule of the four main sections and
// the round "More", whose popover menu holds the other sections
// (MoreIsland) — one markup, reflowing by the `shell` container width.
// Counts and attention marks come from the store: running threads on
// "Threads", a dot on a section that awaits the user (on "More" when that
// section is under it). The shell is one page of the stage (app/stage):
// its route and what the navigation does to its scroll come from the
// page's ScreenNav, not from the store — a page sliding away must not
// learn of the route it leaves for. The toasts, the image viewer and the
// "add workspace" window are the stage's, one for every page.
// The sidebar head is the service icon with "Balabash", then the workspace
// switcher (features/workspaces): the current workspace's mark, name and
// operator, the menu of every workspace this browser is signed in to; its footer — the version and the uptime of the
// process (features/system, the facts read by place) and the sessions
// running (the store).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from '../../lib/router/Link.tsx';
import type { AppRoute, NavKey } from '../../lib/router/routes.ts';
import { useScreenNav } from '../../lib/router/screen.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectConnectionsNeedingAction } from '../../store/connections/selectors.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectRunningCount } from '../../store/threads/selectors.ts';
import { closeMoreMenu, openMoreMenu } from '../../store/ui/actions.ts';
import { selectMoreMenu } from '../../store/ui/selectors.ts';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Attn, Count, Kbd } from '../../ui/atoms/atoms.tsx';
import { stepFocus } from '../../ui/atoms/keys.ts';
import { useSystemFacts } from '../system/queries.ts';
import { WorkspaceSwitcher } from '../workspaces/Workspaces.tsx';
import { MORE, NAV, TABS } from './nav.ts';
import { footerWords, isMainThreadOpen, mainThreadRoute, mainThreadShortcutLabel } from './shell.logic.ts';
import { restoreScroll } from './scroll.ts';
import { ShellTop } from './ShellTop.tsx';
import type { ShellTopProps } from './ShellTop.tsx';
import '../../ui/Glass/Glass.css';
import '../../ui/Island/Island.css';
import './Shell.css';

export type ShellProps = Omit<ShellTopProps, 'running' | 'main'> & {
  current: NavKey | null;
  // A detail screen: no bottom tabs on the phone.
  detail?: boolean;
  // On the phone the screen draws its own header inside the frame (the
  // thread's glass strip) and the shell header hides.
  ownTop?: boolean;
  children: ReactNode;
};

export function Shell({ current, detail, ownTop, children, ...top }: ShellProps) {
  const me = useAppSelector(selectMe);
  const running = useAppSelector(selectRunningCount);
  const attention =
    useAppSelector(selectConnectionsNeedingAction).length > 0 ? new Set<NavKey>(['connections']) : new Set<NavKey>();
  const nav = useScreenNav();
  const { route } = nav;
  const frame = useRef<HTMLDivElement>(null);
  const mainThreadId = me?.mainThreadId ?? null;
  const mainRoute = useMemo(() => mainThreadRoute(mainThreadId), [mainThreadId]);
  const mainOpen = isMainThreadOpen(route, mainThreadId);
  const main = mainRoute ? { route: mainRoute, current: mainOpen } : null;
  // On the main thread no section is current: it has its own item.
  const section = mainOpen ? null : current;
  // The stage reads the frame's place when the page is left, and tells
  // the toasts where to sit (a detail has no tabs under them).
  const frameRef = useCallback(
    (element: HTMLDivElement | null) => {
      frame.current = element;
      nav.frame(element);
    },
    [nav.frame],
  );

  useEffect(() => {
    nav.setDetail(!!detail);
  }, [nav.setDetail, detail]);

  // What the navigation does to the body's place (the stage's word,
  // ScreenNav.scroll): a new screen starts at the top; a move inside the
  // same page keeps its place; a history navigation brings back the place
  // the entry was left at (restoreScroll: now, and again as the screen
  // grows into it, until the reader or the screen moves the frame itself).
  // Before paint, so the frame never shows at the top first. Keyed by the
  // navigation's identity: a new navigation runs it, a render does not.
  useLayoutEffect(() => {
    const box = frame.current;

    if (!box) {
      return undefined;
    }

    if (nav.scroll.kind === 'restore') {
      return restoreScroll(box, nav.scroll.place);
    }

    if (nav.scroll.kind === 'top') {
      box.scrollTop = 0;
    }

    return undefined;
  }, [nav.nav]);

  const facts = useSystemFacts();
  const now = useNow();
  const foot = footerWords(facts.data?.process, running, now);
  const tabCurrent = section === null ? null : TABS.some(item => item.key === section) ? section : 'more';

  return (
    <div className="shell" data-detail={detail ? '' : undefined} data-own-top={ownTop ? '' : undefined}>
      <aside className="shell-side">
        <div className="shell-brand">
          <img className="shell-logo" src="/static/icon-192.png" alt="" width="192" height="192" />
          Balabash
        </div>
        <WorkspaceSwitcher />
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
        {foot ? (
          <div className="shell-foot">
            {foot.version ? (
              <>
                <b className="shell-foot-v">{foot.version}</b> ·{' '}
              </>
            ) : null}
            {foot.uptime}
            <br />
            {foot.sessions}
          </div>
        ) : null}
      </aside>
      <div className="shell-main">
        <div className="shell-frame" ref={frameRef}>
          <ShellTop {...top} running={running} main={main} />
          <main className="shell-body">{children}</main>
          <nav className="shell-tabs" aria-label="Sections">
            <div className="shell-tabs-cap island">
              {TABS.map(item => (
                <Link key={item.key} className="shell-tab" route={item.route} current={item.key === tabCurrent}>
                  <span className="shell-tab-ic">
                    <Icon name={item.icon} />
                    {item.key === 'threads' && running > 0 ? (
                      <Count state="run" size="sm" className="shell-tab-badge">
                        {running}
                      </Count>
                    ) : null}
                  </span>
                  <span className="shell-tab-l">{item.name}</span>
                </Link>
              ))}
            </div>
            <MoreIsland current={tabCurrent === 'more' ? section : null} attention={attention} />
          </nav>
        </div>
      </div>
    </div>
  );
}

const MENU_ITEMS = '[role="menuitem"]';

// The round "More" island and its popover menu (design: Shell, moreOpen):
// the sections outside the capsule, the current one with an accent icon
// and attention dots at the right. More shows "×" while the menu is open
// and carries the lens when a section under it is open (current); the
// yellow dot when one of them awaits the user and the menu is closed. The
// menu opens above the island, aligned to its right edge, with no scrim:
// a tap outside, on "×", Escape or a choice (navigation, the store) closes
// it. The first row takes the focus on open, Up/Down move between the
// rows, Escape hands the focus back to the island.
function MoreIsland({ current, attention }: { current: NavKey | null; attention: Set<NavKey> }) {
  const dispatch = useAppDispatch();
  const open = useAppSelector(selectMoreMenu);
  const island = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const attn = MORE.some(item => attention.has(item.key));

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    menu.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus();

    const onPointer = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && !island.current?.contains(target) && !menu.current?.contains(target)) {
        dispatch(closeMoreMenu());
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatch(closeMoreMenu());
        island.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, dispatch]);

  return (
    <>
      <button
        ref={island}
        type="button"
        className="shell-more island"
        aria-label="More sections"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={current ? 'page' : undefined}
        onClick={() => dispatch(open ? closeMoreMenu() : openMoreMenu())}
      >
        <Icon name={open ? 'x' : 'ellipsis'} />
        {attn && !open ? <Attn className="shell-more-badge" /> : null}
      </button>
      {open ? (
        <div
          ref={menu}
          className="shell-more-menu island"
          role="menu"
          aria-label="More sections"
          onKeyDown={event => stepFocus(event, MENU_ITEMS, 'y')}
        >
          {MORE.map(item => (
            <Link
              key={item.key}
              className="shell-more-i"
              role="menuitem"
              route={item.route}
              current={item.key === current}
            >
              <Icon name={item.icon} />
              {item.name}
              {attention.has(item.key) ? <Attn /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

export type { AppRoute };
