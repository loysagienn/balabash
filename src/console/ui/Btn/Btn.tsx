// Button (design: Btn). variant: primary (one per screen or form) · regular
// (default) · ghost (toolbars, rows) · danger (irreversible). busy — the
// action is in flight: a spinner instead of the icon, and the button does
// not act — a click, Enter or Space, a form's implicit submission through
// it are swallowed. It is not disabled on purpose: the focus stays where it
// is and the design's busy look holds. href — the same button as a link.

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Kbd } from '../atoms/atoms.tsx';
import './Btn.css';

export type BtnVariant = 'primary' | 'ghost' | 'danger';
export type BtnSize = 'sm' | 'lg';

export type BtnProps = {
  label?: ReactNode;
  icon?: IconName;
  iconAfter?: IconName;
  variant?: BtnVariant;
  size?: BtnSize;
  block?: boolean;
  busy?: boolean;
  disabled?: boolean;
  kbd?: string;
  iconOnly?: boolean;
  ariaLabel?: string;
  // Renders the button as a link; a Link of the router wraps a plain Btn
  // instead when the target is a route.
  href?: string;
  // With href: opens in a new tab (an app at its own domain).
  external?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'id' | 'title' | 'autoFocus' | 'tabIndex' | 'form'>;

export function Btn({
  label,
  icon,
  iconAfter,
  variant,
  size,
  block,
  busy,
  disabled,
  kbd,
  iconOnly,
  ariaLabel,
  href,
  external,
  className,
  type = 'button',
  expanded,
  onClick,
  ...rest
}: BtnProps) {
  const lead = busy ? 'loader-circle' : icon;
  const classes = className ? `btn ${className}` : 'btn';
  const activate = busy ? swallow : onClick;
  const content = (
    <>
      {lead ? <Icon name={lead} spin={busy} /> : null}
      {label}
      {iconAfter ? <Icon name={iconAfter} /> : null}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </>
  );
  const data = {
    'data-variant': variant,
    'data-size': size,
    'data-icon-only': iconOnly ? '' : undefined,
    'data-block': block ? '' : undefined,
  };

  if (href !== undefined) {
    return (
      <a
        {...data}
        className={classes}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer' : undefined}
        aria-label={ariaLabel}
        aria-busy={busy ? 'true' : undefined}
        aria-disabled={disabled ? 'true' : undefined}
        onClick={activate}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      {...rest}
      {...data}
      type={type}
      className={classes}
      aria-label={ariaLabel}
      aria-busy={busy ? 'true' : undefined}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={activate}
    >
      {content}
    </button>
  );
}

// The activation of a busy button: nothing happens, and a submit button
// does not submit its form.
function swallow(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
}

// Action link (design: .link) — "All threads ›" in a card header or under a
// list. For a route, a feature renders the router's <Link className="link">
// with the same children instead.
export type ActionLinkProps = {
  label: ReactNode;
  href: string;
  icon?: IconName;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
};

export function ActionLink({ label, href, icon = 'chevron-right', onClick, className }: ActionLinkProps) {
  return (
    <a className={className ? `link ${className}` : 'link'} href={href} onClick={onClick}>
      {label}
      <Icon name={icon} />
    </a>
  );
}
