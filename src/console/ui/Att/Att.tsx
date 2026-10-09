// Attachments of a message or a summary (design: Att, AttThumb): Atts is
// the row; Att — a file as a chip (type icon, name, size), AttThumb — an
// image as a preview. Both are links to the file (href; onClick for a
// feature that opens the preview in place). A long file name is cut with
// an ellipsis inside the chip (the full name is the link's title), so an
// attachment never widens the message.

import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Att.css';

export function Atts({ children }: { children: ReactNode }) {
  return <div className="atts">{children}</div>;
}

export type AttProps = {
  icon?: IconName;
  file: string;
  size?: string;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function Att({ icon = 'file-text', file, size, href, onClick }: AttProps) {
  return (
    <a className="att" href={href} title={file} onClick={onClick}>
      <Icon name={icon} />
      <span className="att-name">{file}</span>
      {size ? <small className="att-size">{size}</small> : null}
    </a>
  );
}

export type AttThumbProps = {
  src: string;
  alt: string;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function AttThumb({ src, alt, href, onClick }: AttThumbProps) {
  return (
    <a className="att-thumb" href={href} onClick={onClick}>
      <img src={src} alt={alt} loading="lazy" />
    </a>
  );
}
