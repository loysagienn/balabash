// <Link route> — an anchor whose href comes from writeRoute and whose plain
// left click (no modifiers, no target) becomes ROUTE_TO; anything else stays
// with the browser (new tab, copy link). `current` marks aria-current="page".
// useLinkProps gives the same href + onClick pair to a ui block that draws
// its own anchor (ThreadRow, ChildThread, Att); useLinkTargets gives it for
// routes known only at render, with the fragment of the URL when the link
// has one (a Markdown link to a section of a file) — the fragment goes with
// the href and with the ROUTE_TO alike, so the click and the new tab land
// on the same URL.

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  route: AppRoute;
  replace?: boolean;
  current?: boolean;
  children?: ReactNode;
};

export function isPlainLeftClick(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

// The pair fits any block that draws an anchor — its own <a> or a Btn with
// href (the event comes from the anchor either way).
export type LinkTarget = { href: string; onClick: (event: MouseEvent<HTMLElement>) => void };

export function useLinkProps(route: AppRoute, replace = false): LinkTarget {
  const linkTarget = useLinkTargets();

  return linkTarget(route, replace);
}

// The same pair for a list of routes known only at render (breadcrumbs,
// the links of a Markdown preview): one hook, a target per route; `hash` —
// the fragment of the URL ('#part' or ''), carried beside the route.
export function useLinkTargets(): (route: AppRoute, replace?: boolean, hash?: string) => LinkTarget {
  const dispatch = useAppDispatch();

  return (route, replace = false, hash = '') => ({
    href: `${writeRoute(route)}${hash}`,
    onClick: event => {
      if (isPlainLeftClick(event)) {
        event.preventDefault();
        dispatch(routeTo(route, { replace, hash }));
      }
    },
  });
}

export function Link({ route, replace = false, current, onClick, target, children, ...rest }: LinkProps) {
  const dispatch = useAppDispatch();

  return (
    <a
      {...rest}
      href={writeRoute(route)}
      target={target}
      aria-current={current ? 'page' : undefined}
      onClick={event => {
        onClick?.(event);

        if (!target && isPlainLeftClick(event)) {
          event.preventDefault();
          dispatch(routeTo(route, { replace }));
        }
      }}
    >
      {children}
    </a>
  );
}
