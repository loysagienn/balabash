// Progress bar (design: Prog) — only for a process with an end (an upload);
// fill levels are rings. indeterminate — a running stripe without a value.

import type { CSSProperties } from 'react';
import './Prog.css';

export type ProgProps = {
  value?: number;
  state?: 'err';
  indeterminate?: boolean;
  label?: string;
  className?: string;
};

export function Prog({ value, state, indeterminate, label, className }: ProgProps) {
  const v = indeterminate || value === undefined ? undefined : Math.max(0, Math.min(100, value));
  const style = v === undefined ? undefined : ({ '--v': `${v}%` } as CSSProperties);

  return (
    <div
      className={className ? `prog ${className}` : 'prog'}
      role="progressbar"
      aria-label={label}
      aria-valuenow={v}
      aria-valuemin={v === undefined ? undefined : 0}
      aria-valuemax={v === undefined ? undefined : 100}
      data-state={state}
      data-indeterminate={indeterminate ? '' : undefined}
      style={style}
    >
      <i className="prog-bar" />
    </div>
  );
}
