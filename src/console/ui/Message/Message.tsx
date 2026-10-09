// Message in the feed (design: Message): "from → to" and the time in the
// header, the body below. variant: task (a task as a card, usually with
// the "task" tag), user (yours, on --surface-2), ask (a question for you,
// with a "reply needed" badge). children — the body: an <Md> and, after
// it, the attachments (<Atts>). fold — a long body starts collapsed with
// "Show more"; quick — quick replies for a question, onQuick gets the one
// pressed. agent / to = "you" is the operator: shown by name (you) when
// Settings has one, else as "you"; the avatar takes the initial.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Badge } from '../Badge/Badge.tsx';
import { Btn } from '../Btn/Btn.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Tag } from '../atoms/atoms.tsx';
import './Message.css';

export type MessageVariant = 'task' | 'user' | 'ask';

export type MessageProps = {
  agent: string;
  to: string;
  you?: string;
  time?: string;
  variant?: MessageVariant;
  tag?: string;
  fold?: boolean;
  quick?: string[];
  onQuick?: (reply: string) => void;
  children: ReactNode;
};

export function Message({ agent, to, you, time, variant, tag, fold, quick, onQuick, children }: MessageProps) {
  const [expanded, setExpanded] = useState(false);
  const folded = fold && !expanded;
  const name = (party: string) => (party === 'you' && you ? you : party);

  return (
    <article className="msg" data-variant={variant}>
      <Avatar agent={agent} you={you} size="sm" className="msg-av" />
      <div className="msg-h">
        <b className="msg-from">{name(agent)}</b>
        <Icon name="arrow-right" className="msg-arrow" />
        <span className="msg-to">{name(to)}</span>
        {tag ? <Tag>{tag}</Tag> : null}
        {variant === 'ask' ? <Badge state="act" label="reply needed" size="sm" /> : null}
        {time ? <span className="msg-time">{time}</span> : null}
      </div>
      <div className="msg-b">
        {folded ? <div className="msg-fold">{children}</div> : children}
        {folded ? (
          <button type="button" className="msg-more" onClick={() => setExpanded(true)}>
            Show more
            <Icon name="chevron-down" />
          </button>
        ) : null}
        {quick && quick.length > 0 ? (
          <div className="msg-quick">
            {quick.map(reply => (
              <Btn key={reply} label={reply} size="sm" onClick={() => onQuick?.(reply)} />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
