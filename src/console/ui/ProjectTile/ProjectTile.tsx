// Project tile (design: ProjectTile) and its grid (design: .tiles —
// projects, apps, catalog): name, description, when it was last worked
// on, the folder, how many threads are running; archived — the archive
// icon. On the phone the grid is a single column with the icon on the
// left.

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Badge } from '../Badge/Badge.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Code } from '../atoms/atoms.tsx';
import { countOf } from '../../lib/format/index.ts';
import './ProjectTile.css';

export function Tiles({ children, min, className }: { children: ReactNode; min?: string; className?: string }) {
  return (
    <div className={className ? `tiles ${className}` : 'tiles'} style={min ? ({ '--tile-min': min } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}

export type ProjectTileProps = {
  title: string;
  desc?: string;
  when: string;
  slug?: string;
  threads?: number;
  archived?: boolean;
  size?: 'sm';
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function ProjectTile({ title, desc, when, slug, threads = 0, archived, size, href, onClick }: ProjectTileProps) {
  return (
    <a className="tile" href={href} onClick={onClick} data-size={size}>
      <Obj icon={archived ? 'archive' : 'folder'} size="md" />
      <span className="tile-t">{title}</span>
      {desc ? <span className="tile-d">{desc}</span> : null}
      <span className="tile-f">
        <span>
          {when}
          {slug ? (
            <>
              {' · '}
              <Code>{slug}</Code>
            </>
          ) : null}
        </span>
        {threads > 0 ? <Badge state="run" label={countOf(threads, 'thread')} size="sm" /> : null}
      </span>
    </a>
  );
}
