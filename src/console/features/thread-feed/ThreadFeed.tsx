// The items of a thread's feed drawn with the ui blocks: messages with
// Markdown and attachments, action groups (FeedAction), the plan, sub-agent
// tasks, child-thread cards with their live state from the store, system
// lines, event lines and error blocks. `now` is the screen's clock for the
// time labels and running timers.

import type { MouseEvent } from 'react';
import { dateTimeLabel, fileSize } from '../../lib/format/index.ts';
import { isPlainLeftClick, useLinkProps } from '../../lib/router/Link.tsx';
import { useAppSelector } from '../../store/hooks.ts';
import { selectThreadState } from '../../store/sessions/selectors.ts';
import { Att, AttThumb, Atts } from '../../ui/Att/Att.tsx';
import { ChildThread } from '../../ui/ChildThread/ChildThread.tsx';
import { ErrorBlock } from '../../ui/ErrorBlock/ErrorBlock.tsx';
import { EvLine } from '../../ui/EvLine/EvLine.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { Message } from '../../ui/Message/Message.tsx';
import { MsgQuiet } from '../../ui/Message/MsgQuiet.tsx';
import { Plan, PlanItem } from '../../ui/Plan/Plan.tsx';
import { Subtask } from '../../ui/Subtask/Subtask.tsx';
import { SysLine } from '../../ui/SysLine/SysLine.tsx';
import { ActGroup } from '../../ui/Xp/Xp.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { FeedAction } from './FeedAction.tsx';
import type { Attachment, ChildItem, FeedItem, MessageItem } from './project.ts';
import { clipLine } from './actions.ts';
import './ThreadFeed.css';

const SUMMARY_MAX = 320;

export function Attachments({ atts }: { atts: Attachment[] }) {
  if (atts.length === 0) {
    return null;
  }

  return (
    <Atts>
      {atts.map(att =>
        att.image ? (
          <AttThumb key={att.key} src={att.href} alt={att.name} href={att.href} />
        ) : (
          <Att key={att.key} icon={fileIcon(att.name)} file={att.name} size={att.size !== null ? fileSize(att.size) : undefined} href={att.href} />
        ),
      )}
    </Atts>
  );
}

function FeedMessage({ item, now }: { item: MessageItem; now: Date }) {
  return (
    <Message agent={item.from} to={item.to} variant={item.variant} tag={item.tag} time={dateTimeLabel(item.at, now)} fold={item.fold}>
      {item.text ? <Md source={item.text} /> : null}
      <Attachments atts={item.atts} />
    </Message>
  );
}

function FeedChild({ item, now }: { item: ChildItem; now: Date }) {
  const live = useAppSelector(s => selectThreadState(s, item.threadId));
  const link = useLinkProps({ key: 'thread', id: item.threadId });
  const state = item.state ?? live ?? 'wait';
  const when = item.endedAt ? `${dateTimeLabel(item.startedAt, now)} → ${dateTimeLabel(item.endedAt, now)}` : dateTimeLabel(item.startedAt, now);

  return (
    <ChildThread
      agent={item.agent}
      title={item.title}
      sub={`${item.agent} agent started · ${when}`}
      state={state}
      href={link.href}
      onOpen={event => {
        if (isPlainLeftClick(event as MouseEvent<HTMLAnchorElement>)) {
          link.onClick(event as MouseEvent<HTMLAnchorElement>);
        }
      }}
    >
      {item.summary ? (
        <>
          <strong>{item.state === 'done' ? 'Summary:' : item.state === 'err' ? 'Error:' : 'Reason:'}</strong> {clipLine(item.summary, SUMMARY_MAX)}
        </>
      ) : null}
    </ChildThread>
  );
}

export function FeedItemView({ item, now }: { item: FeedItem; now: Date }) {
  switch (item.kind) {
    case 'message':
      return <FeedMessage item={item} now={now} />;
    case 'quiet':
      return (
        <MsgQuiet>
          <Md quiet source={item.text} />
        </MsgQuiet>
      );
    case 'actions':
      return (
        <ActGroup>
          {item.items.map(action => (
            <FeedAction key={action.key} item={action} now={now} />
          ))}
        </ActGroup>
      );
    case 'plan':
      return (
        <Plan done={item.done} total={item.total}>
          {item.items.map((entry, i) => (
            <PlanItem key={i} state={entry.state}>
              {entry.text}
            </PlanItem>
          ))}
        </Plan>
      );
    case 'subtask':
      return (
        <Subtask kind={item.taskKind} state={item.state} meta={item.meta} lastCode={item.lastTool ?? undefined}>
          {item.description}
          {item.summary && item.summary !== item.description ? <> — {clipLine(item.summary, SUMMARY_MAX)}</> : null}
        </Subtask>
      );
    case 'child':
      return <FeedChild item={item} now={now} />;
    case 'sys':
      return (
        <SysLine icon={item.icon} level={item.level} state={item.state}>
          {item.text}
        </SysLine>
      );
    case 'ev':
      return (
        <EvLine icon={item.icon} state={item.state}>
          {item.text}
        </EvLine>
      );
    case 'error':
      return (
        <ErrorBlock icon={item.icon} title={item.title}>
          <Code wrap>{item.text}</Code>
        </ErrorBlock>
      );
  }
}

export function FeedItems({ items, now }: { items: FeedItem[]; now: Date }) {
  return items.map(item => <FeedItemView key={item.key} item={item} now={now} />);
}

// Whether any action of the items still runs — the clock then ticks seconds.
export function hasRunningAction(items: FeedItem[]): boolean {
  return items.some(item => item.kind === 'actions' && item.items.some(action => action.endedAt === null || hasRunningAction(action.nested)));
}
