// Empty or failed to load (design: Empty): an icon, what happened, why
// (children) and one action.

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import './Empty.css';

export type EmptyProps = {
  icon: IconName;
  state?: 'err' | 'done';
  title: string;
  action?: string;
  actionIcon?: IconName;
  onAction?: () => void;
  children?: ReactNode;
};

export function Empty({ icon, state, title, action, actionIcon, onAction, children }: EmptyProps) {
  return (
    <div className="empty">
      <Obj icon={icon} size="lg" state={state} className="empty-ic" />
      <span className="empty-t">{title}</span>
      {children ? <span className="empty-d">{children}</span> : null}
      {action ? (
        <span className="empty-acts">
          <Btn label={action} icon={actionIcon} size="sm" onClick={onAction} />
        </span>
      ) : null}
    </div>
  );
}
