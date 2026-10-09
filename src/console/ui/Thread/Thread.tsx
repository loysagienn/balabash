// Thread layout (design: .th): the `thread` container with the header
// (ThreadHead) on top and the body below — the main column (feed and
// composer) and the details rail on the right, which hides when the thread
// is narrower than 900 px. RailSection is a titled group in the rail;
// RailGauge — the context gauge with its caption.

import type { CSSProperties, ReactNode } from 'react';
import { Gauge } from '../Ring/Gauge.tsx';
import './Thread.css';

export function Thread({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className ? `th ${className}` : 'th'} style={style}>
      {children}
    </div>
  );
}

export function ThreadBody({ children }: { children: ReactNode }) {
  return <div className="th-body">{children}</div>;
}

export function ThreadMain({ children }: { children: ReactNode }) {
  return <div className="th-main">{children}</div>;
}

export function ThreadRail({ children, label = 'Thread details' }: { children: ReactNode; label?: string }) {
  return (
    <aside className="th-rail" aria-label={label}>
      {children}
    </aside>
  );
}

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="th-rail-h">{title}</h3>
      {children}
    </section>
  );
}

export function RailGauge({ value, children }: { value: number; children: ReactNode }) {
  return (
    <div className="th-rail-gauge">
      <Gauge value={value} />
      <span>{children}</span>
    </div>
  );
}
