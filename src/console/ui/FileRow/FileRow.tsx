// File row (design: FileRow): object icon, name, the agent's caption (who
// left it and what it says), size, modified time. The row is a div: the
// name is a link stretched over the whole row (rule 14), and the "⋯"
// actions (more — a MenuAnchor) sit above it, visible on hover, focus and
// selection (always on touch screens). dir — a folder: a chevron instead
// of the actions, decoration only — the pointer goes through it to the
// stretched link (data-dir, FileRow.css). Without a caption the second
// line is not rendered. Where the list is narrow, a folder's time leaves
// the time column and joins the caption ("1 folder · 11 files · today" —
// the design's phone rows; the files keep the column): the row renders it
// in both places, FileRow.css shows one.

import type { MouseEvent, ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import './FileRow.css';

export type FileRowProps = {
  name: string;
  icon?: IconName;
  dir?: boolean;
  caption?: string;
  agent?: string;
  size?: string;
  time?: string;
  selected?: boolean;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  // The "⋯" of the row (a MenuAnchor with an IconBtn); none for a folder.
  more?: ReactNode;
};

export function FileRow({ name, icon = 'file-text', dir, caption, agent, size, time, selected, href, onClick, more }: FileRowProps) {
  const folded = dir ? time : undefined;

  return (
    <div className="fr" data-dir={dir ? '' : undefined} aria-selected={selected ? 'true' : undefined}>
      <Obj icon={dir ? 'folder' : icon} size="md" kind={dir ? 'dir' : undefined} />
      <span className="fr-main">
        <a className="fr-n" href={href} onClick={onClick}>
          {name}
        </a>
        {agent || caption || folded ? (
          <span className="fr-c">
            {agent ? <Avatar agent={agent} size="xs" /> : null}
            {caption ? <span className="fr-c-t">{caption}</span> : null}
            {folded ? <span className="fr-c-f">{folded}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="fr-s">{size}</span>
      <span className="fr-t">{time}</span>
      <span className="fr-a">{dir ? <Icon name="chevron-right" size="sm" /> : more}</span>
    </div>
  );
}
