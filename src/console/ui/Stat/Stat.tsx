// Metric (design: Stat): label, value, explanation; the state color only
// for what needs attention. The container (design: .stats) is a grid of
// as many as fit.

import type { CSSProperties, ReactNode } from 'react';
import './Stat.css';

export function Stats({ children, min, className }: { children: ReactNode; min?: string; className?: string }) {
  return (
    <div className={className ? `stats ${className}` : 'stats'} style={min ? ({ '--stat-min': min } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}

export type StatProps = {
  label: string;
  value: ReactNode;
  desc?: string;
  state?: 'err' | 'act';
};

export function Stat({ label, value, desc, state }: StatProps) {
  return (
    <div className="stat" data-state={state}>
      <span className="stat-l">{label}</span>
      <span className="stat-v">{value}</span>
      {desc ? <span className="stat-d">{desc}</span> : null}
    </div>
  );
}
