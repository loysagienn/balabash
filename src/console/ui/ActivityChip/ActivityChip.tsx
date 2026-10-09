// "N threads running" indicator in the shell header (design: ActivityChip);
// 0 — "All quiet". compact — dot and number only.

import type { MouseEvent } from 'react';
import { Pulse } from '../atoms/atoms.tsx';
import { activityChipVals } from './ActivityChip.logic.ts';
import './ActivityChip.css';

export type ActivityChipProps = {
  running: number;
  compact?: boolean;
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function ActivityChip({ running, compact, expanded, onClick }: ActivityChipProps) {
  const vals = activityChipVals(running);

  if (vals.quiet) {
    return (
      <button type="button" className="actchip" aria-expanded={expanded ?? false} data-state="off" aria-label={vals.aria} onClick={onClick}>
        <Pulse off />
        <span className="actchip-l">All quiet</span>
      </button>
    );
  }

  return (
    <button type="button" className="actchip" aria-expanded={expanded ?? false} data-compact={compact ? '' : undefined} aria-label={vals.aria} onClick={onClick}>
      <Pulse />
      <b className="actchip-n">{vals.n}</b>
      <span className="actchip-l">{vals.label}</span>
    </button>
  );
}
