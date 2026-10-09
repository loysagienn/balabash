// Error in the feed (design: ErrorBlock): a tinted block without a solid
// fill — what happened (title, children) and what can be done (action,
// action2).

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './ErrorBlock.css';

export type ErrorBlockProps = {
  icon?: IconName;
  title: string;
  action?: string;
  actionVariant?: BtnVariant;
  actionBusy?: boolean;
  onAction?: () => void;
  action2?: string;
  onAction2?: () => void;
  children: ReactNode;
};

export function ErrorBlock({
  icon = 'circle-alert',
  title,
  action,
  actionVariant,
  actionBusy,
  onAction,
  action2,
  onAction2,
  children,
}: ErrorBlockProps) {
  return (
    <div className="errblock" role="alert">
      <Icon name={icon} className="errblock-ic" />
      <b className="errblock-t">{title}</b>
      <p className="errblock-d">{children}</p>
      {action ? (
        <div className="errblock-acts">
          <Btn label={action} variant={actionVariant} size="sm" busy={actionBusy} onClick={onAction} />
          {action2 ? <Btn label={action2} variant="ghost" size="sm" onClick={onAction2} /> : null}
        </div>
      ) : null}
    </div>
  );
}
