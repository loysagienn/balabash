// Banner (design: Note): a tinted state strip with text (children) and one
// action on the right. role="alert" for errors that interrupt, "status"
// for quiet progress.

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Note.css';

export type NoteProps = {
  state?: 'wait' | 'act' | 'err' | 'off';
  icon?: IconName;
  role?: 'alert' | 'status';
  action?: string;
  actionIcon?: IconName;
  actionVariant?: BtnVariant;
  actionBusy?: boolean;
  onAction?: () => void;
  children: ReactNode;
};

export function Note({ state, icon = 'info', role, action, actionIcon, actionVariant, actionBusy, onAction, children }: NoteProps) {
  return (
    <div className="note" role={role} data-state={state}>
      <Icon name={icon} className="note-ic" />
      <div>{children}</div>
      {action ? (
        <span className="note-end">
          <Btn label={action} icon={actionIcon} variant={actionVariant} size="sm" busy={actionBusy} onClick={onAction} />
        </span>
      ) : null}
    </div>
  );
}
