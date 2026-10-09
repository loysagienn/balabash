// Page section tabs (design: Tab): a tablist under a page header or in a
// filter bar; the selected tab is underlined with the accent.

import type { MouseEvent, ReactNode } from 'react';
import { Count } from '../atoms/atoms.tsx';
import './Tabs.css';

export function Tabs({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `tabs ${className}` : 'tabs'} role="tablist" aria-label={label}>
      {children}
    </div>
  );
}

export type TabProps = {
  label: ReactNode;
  n?: number | string;
  sel: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  controls?: string;
};

export function Tab({ label, n, sel, onClick, controls }: TabProps) {
  return (
    <button type="button" className="tab" role="tab" aria-selected={sel} aria-controls={controls} tabIndex={sel ? 0 : -1} onClick={onClick}>
      {label}
      {n !== undefined && n !== '' ? <Count>{n}</Count> : null}
    </button>
  );
}
