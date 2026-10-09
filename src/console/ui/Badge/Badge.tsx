// State badge (design: Badge). done / err / off show an icon, the live
// states a dot (blinking for run). In a narrow list the badge turns
// compact by the list's container query — no prop needed.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { stateIcon } from '../atoms/state.ts';
import type { StateName } from '../atoms/state.ts';
import './Badge.css';

export type BadgeProps = {
  state: StateName;
  label: ReactNode;
  size?: 'sm';
  className?: string;
};

export function Badge({ state, label, size, className }: BadgeProps) {
  const icon = stateIcon(state);

  return (
    <span className={className ? `badge ${className}` : 'badge'} data-state={state} data-size={size}>
      {icon ? <Icon name={icon} /> : <i className="badge-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
