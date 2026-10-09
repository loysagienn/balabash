// Card (design: .card) and its header (design: CardHead): title, count,
// tag, custom content on the right (children) and an "All …" link. On the
// phone narrow="bare" drops the frame — the header becomes a section title.
// The link slot takes an anchor with the `link` class: ActionLink for a
// plain href, or the router's <Link className="link"> from a feature.

import type { ReactNode, Ref } from 'react';
import { Count, Tag } from '../atoms/atoms.tsx';
import './Card.css';

export type CardProps = {
  children: ReactNode;
  narrow?: 'bare';
  className?: string;
  as?: 'section' | 'div' | 'article';
  label?: string;
  // The card's element, for a screen that scrolls it into view.
  ref?: Ref<HTMLElement>;
};

export function Card({ children, narrow, className, as: Tag = 'section', label, ref }: CardProps) {
  return (
    // One of three block tags; to the caller the element is an HTMLElement.
    <Tag ref={ref as Ref<HTMLDivElement> | undefined} className={className ? `card ${className}` : 'card'} data-narrow={narrow} aria-label={label}>
      {children}
    </Tag>
  );
}

export type CardHeadProps = {
  title: ReactNode;
  count?: number | string;
  countState?: 'run' | 'act' | 'err';
  tag?: string;
  link?: ReactNode;
  children?: ReactNode;
};

export function CardHead({ title, count, countState, tag, link, children }: CardHeadProps) {
  const hasCount = count !== undefined && count !== '';

  return (
    <div className="card-h">
      <h3 className="card-t">{title}</h3>
      {hasCount ? <Count state={countState}>{count}</Count> : null}
      {tag ? <Tag>{tag}</Tag> : null}
      {children || link ? (
        <span className="card-h-end">
          {children}
          {link}
        </span>
      ) : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `card-b ${className}` : 'card-b'}>{children}</div>;
}

export function CardFoot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `card-f ${className}` : 'card-f'}>{children}</div>;
}
