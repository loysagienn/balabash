// Message in the feed (design: Message): the author and the time in the
// header, the body below — "author → recipient" only between two agents
// (a task, a report, a child's message); an agent writes into the thread,
// not to a person (a workspace may have several people), so a message from
// or to a person — the operator, a reply written in an external system —
// shows its author alone (showsRecipient). variant: task (a task as a card, usually with
// the "task" tag), user (yours, on --surface-2), ask (a question for you,
// with a "reply needed" badge). children — the body: an <Md> and, after
// it, the attachments (<Atts>). fold — a long body starts collapsed with
// "Show more"; quick — quick replies for a question, onQuick gets the one
// pressed; link — a way into the external system beside them ("Sign in",
// primary, for a sign-in; "Open in the external system" otherwise).
// decided — the question is resolved: no badge, no buttons, the card loses
// its amber edge, a line under the text says the outcome (and who
// decided). agent / to = "you" is the operator: shown by name (you) when
// Settings has one, else as "you"; the avatar takes the initial — a name
// outside the catalog (a reply written in an external system, tag
// "external") gets its initial on the neutral color.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Badge } from '../Badge/Badge.tsx';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnVariant } from '../Btn/Btn.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Tag } from '../atoms/atoms.tsx';
import './Message.css';

export type MessageVariant = 'task' | 'user' | 'ask';

export type MessageLink = { href: string; label: string; variant?: BtnVariant };

// Whether the header names the recipient: only between two agents — never
// when the operator ("you") writes or is written to, nor for a reply from
// a person in an external system (tag "external").
export function showsRecipient(agent: string, to: string, tag?: string): boolean {
  return agent !== 'you' && to !== 'you' && to !== '' && tag !== 'external';
}

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
  link?: MessageLink;
  decided?: string;
  children: ReactNode;
};

export function Message({ agent, to, you, time, variant, tag, fold, quick, onQuick, link, decided, children }: MessageProps) {
  const [expanded, setExpanded] = useState(false);
  const folded = fold && !expanded;
  const name = (party: string) => (party === 'you' && you ? you : party);
  const open = variant === 'ask' && !decided;

  return (
    <article className="msg" data-variant={variant} data-decided={decided ? '' : undefined}>
      <Avatar agent={agent} you={you} size="sm" className="msg-av" />
      <div className="msg-h">
        <b className="msg-from">{name(agent)}</b>
        {showsRecipient(agent, to, tag) ? (
          <>
            <Icon name="arrow-right" className="msg-arrow" />
            <span className="msg-to">{to}</span>
          </>
        ) : null}
        {tag ? <Tag>{tag}</Tag> : null}
        {open ? <Badge state="act" label="reply needed" size="sm" /> : null}
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
        {(quick && quick.length > 0) || link ? (
          <div className="msg-quick">
            {quick?.map(reply => (
              <Btn key={reply} label={reply} size="sm" onClick={() => onQuick?.(reply)} />
            ))}
            {link ? <Btn label={link.label} iconAfter="arrow-up-right" size="sm" variant={link.variant} href={link.href} /> : null}
          </div>
        ) : null}
        {decided ? (
          <p className="msg-decided">
            <Icon name="check" />
            <span>{decided}</span>
          </p>
        ) : null}
      </div>
    </article>
  );
}
