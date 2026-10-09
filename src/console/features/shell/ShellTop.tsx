// Shell header (design: ShellTop): "back" and the section above the page,
// the title, a subtitle; on the right the main thread button (phone only,
// on top-level screens — a page with "back" leaves the room to its title)
// and the activity indicator. pageHead — the page has its own titled
// header: on wide screens the shell header shows only "← Section". The
// bell joins with notifications (plan, stage 7).

import { Link } from '../../lib/router/Link.tsx';
import type { AppRoute } from '../../lib/router/routes.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { ActivityChip } from '../../ui/ActivityChip/ActivityChip.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';

export type MainThreadLink = { route: AppRoute; current: boolean };

export type ShellTopProps = {
  title: string;
  // The title on the phone when it differs: a file's name on the file
  // screen, where the wide header names the folder (the preview header
  // already names the file there).
  titleNarrow?: string;
  sub?: string;
  // The section above the page ("Threads") and where it leads.
  crumb?: { label: string; route: AppRoute };
  // Where "back" leads; the browser's history when the screen was entered
  // from inside the app is the screen's own call (it passes a route here).
  back?: AppRoute;
  // "Back" only on the phone: the detail of a split view, whose list stays
  // beside it on a wide shell (Agents, Schedule).
  backNarrow?: boolean;
  pageHead?: boolean;
  compact?: boolean;
  running: number;
  // The main thread's link for the phone header; null until the session
  // names the thread.
  main: MainThreadLink | null;
};

export function ShellTop({ title, titleNarrow, sub, crumb, back, backNarrow, pageHead, compact, running, main }: ShellTopProps) {
  const dispatch = useAppDispatch();

  return (
    <header className="shell-top" data-title={pageHead ? 'narrow' : undefined} data-back={backNarrow ? 'narrow' : undefined}>
      {back ? <IconBtn icon="arrow-left" label="Back" size="sm" className="shell-back" onClick={() => dispatch(routeTo(back))} /> : null}
      {crumb ? (
        <>
          <Link className="shell-crumb" route={crumb.route}>
            {crumb.label}
          </Link>
          <span className="shell-crumb-sep">/</span>
        </>
      ) : null}
      <h1 className="shell-title">
        {titleNarrow === undefined ? (
          title
        ) : (
          <>
            <span className="shell-title-wide">{title}</span>
            <span className="shell-title-narrow">{titleNarrow}</span>
          </>
        )}
      </h1>
      {sub ? <span className="shell-sub">{sub}</span> : null}
      <div className="shell-top-end">
        {main && !back ? (
          <Link className="btn shell-mt-btn" data-icon-only="" route={main.route} current={main.current} aria-label="Main thread" title="Main thread">
            <Icon name="message-circle" />
          </Link>
        ) : null}
        <ActivityChip running={running} compact={compact} onClick={() => dispatch(routeTo({ key: 'threads', status: 'active' }))} />
      </div>
    </header>
  );
}
