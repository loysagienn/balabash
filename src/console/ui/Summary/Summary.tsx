// Summary of a completed thread (design: Summary) — first under the
// header: what the thread is opened for. children — an <Md> and the
// attachments (<Atts>).

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import './Summary.css';

export function Summary({ time, children }: { time?: string; children: ReactNode }) {
  return (
    <section className="summary" aria-label="Summary">
      <div className="summary-h">
        <Icon name="circle-check" />
        Summary
        {time ? <span className="summary-h-end">{time}</span> : null}
      </div>
      <div className="summary-b">{children}</div>
    </section>
  );
}
