// "N new" pill (design: .newpill): rows that arrived while the list was
// scrolled wait above; the pill names them and, pressed, takes the reader
// to the top where they are.

import type { MouseEvent } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import './NewPill.css';

export function NewPill({ label, onClick, className }: { label: string; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; className?: string }) {
  return (
    <button type="button" className={className ? `newpill ${className}` : 'newpill'} onClick={onClick}>
      <Icon name="arrow-up" />
      {label}
    </button>
  );
}
