// Fill ring (design: Ring): a percentage drawn as an arc; the color follows
// the level (Ring.logic.ts). Decorative — the caller names the value.

import { ringDash, ringLevel } from './Ring.logic.ts';
import type { RingLevel } from './Ring.logic.ts';
import './Ring.css';

export type RingProps = {
  value: number;
  size?: 'lg';
  // Overrides the level computed from the value.
  level?: RingLevel;
};

export function Ring({ value, size, level }: RingProps) {
  return (
    <svg className="ring" viewBox="0 0 24 24" data-level={level ?? ringLevel(value)} data-size={size} aria-hidden="true">
      <circle className="ring-trk" cx="12" cy="12" r="10" />
      <circle className="ring-bar" cx="12" cy="12" r="10" pathLength={100} strokeDasharray={ringDash(value)} />
    </svg>
  );
}
