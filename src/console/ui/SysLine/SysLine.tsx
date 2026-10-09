// System divider (design: SysLine) — an event of the whole thread, a full
// width line through the feed. level: normal (notifications, stages) ·
// urgent (bold, amber); state — the state color instead.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import type { StateName } from '../atoms/state.ts';
import './SysLine.css';

export type SysLineProps = {
  icon?: IconName;
  level?: 'normal' | 'urgent';
  state?: StateName;
  children: ReactNode;
};

export function SysLine({ icon, level, state, children }: SysLineProps) {
  return (
    <div className="sysline" role="separator" data-level={level} data-state={state}>
      {icon ? <Icon name={icon} /> : null}
      <span className="sysline-t">{children}</span>
    </div>
  );
}
