// A notification in the bell popover (design: Notification): what
// happened (an object icon tinted by state), an explanation, one action;
// unread is marked with an accent dot by the time. Buttons are part of the
// block itself (.ntf-acts).

import type { MouseEvent } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import './Notification.css';

export type NotificationProps = {
  icon?: IconName;
  state?: 'act' | 'err';
  title: string;
  desc?: string;
  action?: string;
  onAction?: (event: MouseEvent<HTMLElement>) => void;
  time: string;
  unread?: boolean;
};

export function Notification({ icon = 'bell', state, title, desc, action, onAction, time, unread }: NotificationProps) {
  return (
    <div className="ntf">
      <Obj icon={icon} size="md" state={state} />
      <div className="ntf-main">
        <div className="ntf-t">{title}</div>
        {desc ? <div className="ntf-d">{desc}</div> : null}
        {action ? (
          <div className="ntf-acts">
            <Btn label={action} size="sm" onClick={onAction} />
          </div>
        ) : null}
      </div>
      <span className="ntf-time">
        {time}
        {unread ? <i className="ntf-unread" aria-label="unread" /> : null}
      </span>
    </div>
  );
}
