// Banner (design: Note): a tinted state strip with text (children) and one
// action on the right — or two, where the user is asked to choose
// (secondary beside the action: a quieter one). role="alert" for errors
// that interrupt, "status" for quiet progress.

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
  secondary?: string;
  secondaryIcon?: IconName;
  onSecondary?: () => void;
  children: ReactNode;
};

export function Note({ state, icon = 'info', role, action, actionIcon, actionVariant, actionBusy, onAction, secondary, secondaryIcon, onSecondary, children }: NoteProps) {
  return (
    <div className="note" role={role} data-state={state}>
      <Icon name={icon} className="note-ic" />
      <div>{children}</div>
      {action || secondary ? (
        <span className="note-end">
          {secondary ? <Btn label={secondary} icon={secondaryIcon} variant="ghost" size="sm" onClick={onSecondary} /> : null}
          {action ? <Btn label={action} icon={actionIcon} variant={actionVariant} size="sm" busy={actionBusy} onClick={onAction} /> : null}
        </span>
      ) : null}
    </div>
  );
}
