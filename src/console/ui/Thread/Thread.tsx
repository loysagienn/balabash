// Thread layout (design: .th): the `thread` container with the glass strip
// (ThreadHead, a narrow thread only) on top and the body below — the main
// column (feed and composer) and the details rail on the right, pinned
// while the feed scrolls, which gives way to the strip when the thread is
// 900 px or narrower. RailSection is a titled group in the rail; RailGauge —
// the context gauge with its caption.

import type { CSSProperties, ReactNode, Ref } from 'react';
import type { FileDropHandlers } from '../../lib/upload/useFileDrop.ts';
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

// The main column; `drop` — the handlers of files dragged over it (the
// owner shows the Drop frame), `ref` — the column itself (the frame is
// placed over the part of it in view).
export function ThreadMain({ children, drop, ref }: { children: ReactNode; drop?: FileDropHandlers; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="th-main" {...drop}>
      {children}
    </div>
  );
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
