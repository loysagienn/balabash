// <Link route> — an anchor whose href comes from writeRoute and whose plain
// left click (no modifiers, no target) becomes ROUTE_TO; anything else stays
// with the browser (new tab, copy link). `current` marks aria-current="page".
// useLinkProps gives the same href + onClick pair to a ui block that draws
// its own anchor (ThreadRow, ChildThread, Att).

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

export function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export type LinkTarget = { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };

export function useLinkProps(route: AppRoute, replace = false): LinkTarget {
  const dispatch = useAppDispatch();

  return {
    href: writeRoute(route),
    onClick: event => {
      if (isPlainLeftClick(event)) {
        event.preventDefault();
        dispatch(routeTo(route, { replace }));
      }
    },
  };
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
