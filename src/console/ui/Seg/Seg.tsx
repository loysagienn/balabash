// Segmented control (design: SegItem): modes of a list — Active · All ·
// Mine — on one line with the filters; the selected segment is raised.
// Only the selected segment is in the Tab order; Left/Right, Home and End
// move between the segments and select (atoms/keys.ts).

import type { MouseEvent, ReactNode } from 'react';
import { tablistKeyDown } from '../atoms/keys.ts';
import './Seg.css';

export function Seg({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="tablist" aria-label={label} onKeyDown={tablistKeyDown}>
      {children}
    </div>
  );
}

export type SegItemProps = {
  label: ReactNode;
  n?: number | string;
  sel: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function SegItem({ label, n, sel, onClick }: SegItemProps) {
  return (
    <button type="button" className="seg-i" role="tab" aria-selected={sel} tabIndex={sel ? 0 : -1} onClick={onClick}>
      {label}
      {n !== undefined && n !== '' ? <span className="seg-n">{n}</span> : null}
    </button>
  );
}
