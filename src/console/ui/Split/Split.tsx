// List and details (design: .split): two panels side by side on a wide
// shell; on the phone only the one named by view — the details are a
// separate screen there. DetailSection (design: .dsec) — a section of the
// details with a small heading (the first one has none); sections inside
// a card are separated by a line.

import type { ReactNode } from 'react';
import './Split.css';

export function Split({ view, children, className }: { view: 'list' | 'detail'; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `split ${className}` : 'split'} data-view={view}>
      {children}
    </div>
  );
}

export function SplitList({ children }: { children: ReactNode }) {
  return <div className="split-list">{children}</div>;
}

export function SplitDetail({ children }: { children: ReactNode }) {
  return <div className="split-detail">{children}</div>;
}

export function DetailSection({ title, end, children }: { title?: string; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="dsec">
      {title || end ? (
        <div className="dsec-h">
          {title ? <h3 className="dsec-t">{title}</h3> : null}
          {end ? <span className="dsec-end">{end}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
