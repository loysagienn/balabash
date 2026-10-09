// Toast (design: Toast): the result of an action or a background event.
// children — the explanation; action / action2 — what can be done;
// progress — a bar for a process with an end (then there is no "Close").

import type { ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Prog } from '../Prog/Prog.tsx';
import type { StateName } from '../atoms/state.ts';
import './Toast.css';

export type ToastProps = {
  state?: StateName;
  icon?: IconName;
  title: string;
  action?: string;
  onAction?: () => void;
  action2?: string;
  onAction2?: () => void;
  progress?: number;
  onClose?: () => void;
  children?: ReactNode;
};

export function Toast({ state, icon = 'circle-check', title, action, onAction, action2, onAction2, progress, onClose, children }: ToastProps) {
  const hasProgress = progress !== undefined;

  return (
    <div className="toast" role="status" data-state={state}>
      <Icon name={icon} className="toast-ic" />
      <div className="toast-body">
        <div className="toast-t">{title}</div>
        {children ? <div className="toast-d">{children}</div> : null}
        {action ? (
          <div className="toast-acts">
            <Btn label={action} size="sm" onClick={onAction} />
            {action2 ? <Btn label={action2} variant="ghost" size="sm" onClick={onAction2} /> : null}
          </div>
        ) : null}
        {hasProgress ? <Prog value={progress} className="toast-prog" label={title} /> : null}
      </div>
      {!hasProgress && onClose ? <IconBtn icon="x" label="Close" size="sm" className="toast-close" onClick={onClose} /> : null}
    </div>
  );
}
