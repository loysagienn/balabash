// Object page header (design: PageHead): title (+ "archived"), description,
// folder, dates; actions (children) and a "⋯" button on the right. On the
// phone the title moves into the shell header — the block hides its own.

import type { MouseEvent, ReactNode } from 'react';
import { Badge } from '../Badge/Badge.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Code } from '../atoms/atoms.tsx';
import './PageHead.css';

export type PageHeadProps = {
  title: string;
  desc?: string;
  // The object's folder, shown as a code chip after a folder icon.
  slug?: string;
  created?: string;
  work?: string;
  archived?: boolean;
  children?: ReactNode;
  onMore?: (event: MouseEvent<HTMLElement>) => void;
  moreExpanded?: boolean;
};

export function PageHead({ title, desc, slug, created, work, archived, children, onMore, moreExpanded }: PageHeadProps) {
  const hasMeta = slug || created || work;

  return (
    <header className="phead">
      <div className="phead-main">
        <h2 className="phead-t">
          {title}
          {archived ? <Badge state="off" label="archived" /> : null}
        </h2>
        {desc ? <p className="phead-d">{desc}</p> : null}
        {hasMeta ? (
          <div className="phead-m">
            {slug ? (
              <>
                <Icon name="folder" size="sm" />
                <Code>{slug}</Code>
              </>
            ) : null}
            {created ? <span>{created}</span> : null}
            {work ? <span>{work}</span> : null}
          </div>
        ) : null}
      </div>
      {children || onMore ? (
        <div className="phead-acts">
          {children}
          {onMore ? <IconBtn icon="ellipsis" label="More" variant="regular" expanded={moreExpanded} onClick={onMore} /> : null}
        </div>
      ) : null}
    </header>
  );
}
