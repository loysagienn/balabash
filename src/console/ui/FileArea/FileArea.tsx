// File area layout (design: .fa) — one component with different roots:
// the workspace folder in "Files", the project folder on a project page.
// The `fa` container: the list (FaList) with its bar (FaBar: breadcrumbs
// and actions), the column headings (FileListHead, hidden when the list is
// narrower than 520 px), the rows (FaRows) and a footer (FaFoot); the
// preview (FaPreview) on the right. view — which panel shows when only one
// fits (narrower than 720 px, or without split); split — both side by side
// when wide. The area fills its parent's height (min-height 0, the rows and
// the preview body scroll).

import type { CSSProperties, ReactNode } from 'react';
import './FileArea.css';

export type FileAreaProps = {
  view: 'list' | 'preview';
  split?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function FileArea({ view, split, children, className, style }: FileAreaProps) {
  return (
    <div className={className ? `fa ${className}` : 'fa'} data-view={view} data-split={split ? '' : undefined} style={style}>
      {children}
    </div>
  );
}

export function FaList({ children }: { children: ReactNode }) {
  return <div className="fa-list">{children}</div>;
}

export function FaPreview({ children }: { children: ReactNode }) {
  return <div className="fa-preview">{children}</div>;
}

// The path (Crumbs with `fa`) and the actions on the right.
export function FaBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="fa-bar">
      {children}
      {end ? <span className="fa-bar-end">{end}</span> : null}
    </div>
  );
}

export function FileListHead() {
  return (
    <div className="fa-head" aria-hidden="true">
      <span />
      <span>name</span>
      <span className="fa-head-r">size</span>
      <span className="fa-head-r">modified</span>
      <span />
    </div>
  );
}

export function FaRows({ children, busy, className }: { children: ReactNode; busy?: boolean; className?: string }) {
  return (
    <div className={className ? `fa-rows ${className}` : 'fa-rows'} aria-busy={busy ? 'true' : undefined}>
      {children}
    </div>
  );
}

export function FaFoot({ children }: { children: ReactNode }) {
  return <div className="fa-foot">{children}</div>;
}
