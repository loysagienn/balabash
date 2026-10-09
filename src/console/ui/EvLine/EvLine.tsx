// Event inside an agent turn (design: EvLine) — a line indented to the
// avatar column: an API retry, a message delivered mid-turn.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import type { StateName } from '../atoms/state.ts';
import './EvLine.css';

export function EvLine({
  icon = 'rotate-ccw',
  state,
  children,
}: {
  icon?: IconName;
  state?: StateName;
  children: ReactNode;
}) {
  return (
    <div className="evline" data-state={state}>
      <Icon name={icon} />
      {children}
    </div>
  );
}
