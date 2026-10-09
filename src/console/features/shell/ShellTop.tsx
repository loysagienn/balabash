// Shell header (design: ShellTop): "back" and the section above the page,
// the title, a subtitle; on the right the activity indicator. pageHead —
// the page has its own titled header: on wide screens the shell header
// shows only "← Section". The bell joins with notifications (plan, stage 7).

import { Link } from '../../lib/router/Link.tsx';
import type { AppRoute } from '../../lib/router/routes.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { ActivityChip } from '../../ui/ActivityChip/ActivityChip.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';

export type ShellTopProps = {
  title: string;
  sub?: string;
  // The section above the page ("Threads") and where it leads.
  crumb?: { label: string; route: AppRoute };
  // Where "back" leads; the browser's history when the screen was entered
  // from inside the app is the screen's own call (it passes a route here).
  back?: AppRoute;
  pageHead?: boolean;
  compact?: boolean;
  running: number;
};

export function ShellTop({ title, sub, crumb, back, pageHead, compact, running }: ShellTopProps) {
  const dispatch = useAppDispatch();

  return (
    <header className="shell-top" data-title={pageHead ? 'narrow' : undefined}>
      {back ? <IconBtn icon="arrow-left" label="Back" size="sm" className="shell-back" onClick={() => dispatch(routeTo(back))} /> : null}
      {crumb ? (
        <>
          <Link className="shell-crumb" route={crumb.route}>
            {crumb.label}
          </Link>
          <span className="shell-crumb-sep">/</span>
        </>
      ) : null}
      <h1 className="shell-title">{title}</h1>
      {sub ? <span className="shell-sub">{sub}</span> : null}
      <div className="shell-top-end">
        <ActivityChip running={running} compact={compact} onClick={() => dispatch(routeTo({ key: 'threads', status: 'active' }))} />
      </div>
    </header>
  );
}
