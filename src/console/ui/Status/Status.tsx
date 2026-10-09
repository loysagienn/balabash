// Compact state (design: Status): a dot or an icon and a label; icon —
// a custom icon instead of the state's standard one.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { stateIcon } from '../atoms/state.ts';
import type { StateName } from '../atoms/state.ts';
import './Status.css';

export type StatusProps = {
  state: StateName;
  label?: ReactNode;
  icon?: IconName;
  className?: string;
};

export function Status({ state, label, icon, className }: StatusProps) {
  const name = icon ?? stateIcon(state);

  return (
    <span className={className ? `st ${className}` : 'st'} data-state={state}>
      {name ? <Icon name={name} /> : <i className="st-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
