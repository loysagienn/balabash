// Claude subscription limit (design: Limit): the ring, the window, the
// reset and the state; loading — a skeleton of the same shape. The
// container (design: .lims) lays limits in a row as many as fit, or
// stacked (layout="stack"); on the phone narrow="tiles" makes them tiles.
// The level of the state label follows the ring's rule (Ring.logic.ts).

import type { CSSProperties, ReactNode } from 'react';
import { Gauge } from '../Ring/Gauge.tsx';
import { Ring } from '../Ring/Ring.tsx';
import { ringLevel } from '../Ring/Ring.logic.ts';
import { SkelStack } from '../Skel/Skel.tsx';
import './Limit.css';

export function Limits({
  children,
  layout,
  narrow,
  min,
  className,
}: {
  children: ReactNode;
  layout?: 'stack';
  narrow?: 'tiles';
  min?: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `lims ${className}` : 'lims'}
      data-layout={layout}
      data-narrow={narrow}
      style={min ? ({ '--lim-min': min } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

export type LimitProps =
  | { loading: true }
  | {
      loading?: false;
      title: string;
      meta: string;
      // Percentage used; 100 and above is "over".
      value: number;
      label: string;
    };

export function Limit(props: LimitProps) {
  if (props.loading) {
    return (
      <div className="lim" aria-busy="true">
        <Ring value={0} size="lg" />
        <div className="lim-main">
          <SkelStack widths={[40, 70]} />
        </div>
      </div>
    );
  }

  const { title, meta, value, label } = props;

  return (
    <div className="lim">
      <Gauge value={value} />
      <div className="lim-main">
        <span className="lim-t">{title}</span>
        <span className="lim-m">{meta}</span>
        <span className="lim-s" data-level={ringLevel(value)}>
          {label}
        </span>
      </div>
    </div>
  );
}
