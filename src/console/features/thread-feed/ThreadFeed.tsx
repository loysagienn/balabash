// The items of a thread's feed drawn with the ui blocks: messages with
// Markdown and attachments, thoughts as text, action groups (FeedAction), the plan, sub-agent
// tasks, child-thread cards with their live state from the store, system
// lines, event lines and error blocks. `now` is the screen's clock for the
// time labels and running timers.

import type { MouseEvent } from 'react';
import { dateTimeLabel, fileSize } from '../../lib/format/index.ts';
import { isPlainLeftClick, useLinkProps } from '../../lib/router/Link.tsx';
import { useQueryClient } from '@tanstack/react-query';
import type { FileMetaResponse } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { openViewer } from '../../store/ui/actions.ts';
import { commandThread } from '../../store/threads/actions.ts';
import { selectThreadCommandPending } from '../../store/ui/selectors.ts';
import { selectUserName } from '../../store/session/selectors.ts';
import { selectThreadState } from '../../store/sessions/selectors.ts';
import { Att, AttThumb, Atts } from '../../ui/Att/Att.tsx';
import { ChildThread } from '../../ui/ChildThread/ChildThread.tsx';
import { ErrorBlock } from '../../ui/ErrorBlock/ErrorBlock.tsx';
import { EvLine } from '../../ui/EvLine/EvLine.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { Message, showsRecipient } from '../../ui/Message/Message.tsx';
import { MsgQuiet } from '../../ui/Message/MsgQuiet.tsx';
import { Plan, PlanItem } from '../../ui/Plan/Plan.tsx';
import { Subtask } from '../../ui/Subtask/Subtask.tsx';
import { SysLine } from '../../ui/SysLine/SysLine.tsx';
import { Thought } from '../../ui/Thought/Thought.tsx';
import { ActGroup, actFold } from '../../ui/Xp/Xp.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { FeedAction } from './FeedAction.tsx';
import { attachmentFacts, downloadHref, needsMeta } from './attachments.ts';
import { askDecidedWords, askKindTag } from './project.ts';
import type { Attachment, ChildItem, FeedItem, MessageItem } from './project.ts';
import { useFileMeta } from './queries.ts';
import { actionDuration, clipLine } from './actions.ts';
import './ThreadFeed.css';

const SUMMARY_MAX = 320;

// One attachment: the facts the event recorded, else the stored file's meta
// (asked for a file the history names by id alone), else the word of its
// kind — the chip is a link to the file either way (attachments.ts). An
// image opens in the image viewer (onOpen); a file — in a new tab.
function AttachmentView({ att, onOpen }: { att: Attachment; onOpen: (key: string) => void }) {
  const meta = useFileMeta(att.fileId, needsMeta(att));
  const facts = attachmentFacts(att, meta.data);

  return facts.image ? (
    <AttThumb
      src={att.href}
      alt={facts.name}
      href={att.href}
      onClick={event => {
        if (isPlainLeftClick(event)) {
          event.preventDefault();
          onOpen(att.key);
        }
      }}
    />
  ) : (
    <Att icon={fileIcon(facts.name)} file={facts.name} size={facts.size !== null ? fileSize(facts.size) : undefined} href={att.href} />
  );
}

// The attachments of one message or summary; `context` — who sent them
// where and when, for the viewer's details line. The viewer steps through
// the images of this row alone.
export function Attachments({ atts, context }: { atts: Attachment[]; context?: string }) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();

  if (atts.length === 0) {
    return null;
  }

  const open = (key: string) => {
    const images = atts.flatMap(att => {
      const cached = att.fileId ? queryClient.getQueryData<FileMetaResponse>(['file-meta', att.fileId]) : undefined;
      const facts = attachmentFacts(att, cached?.file);

      return facts.image ? [{ att, facts }] : [];
    });

    dispatch(
      openViewer(
        images.map(({ att, facts }) => ({
          src: att.href,
          name: facts.name,
          meta: [...(facts.size !== null ? [fileSize(facts.size)] : []), ...(context ? [context] : [])],
          download: att.fileId ? downloadHref(att.href) : null,
        })),
        Math.max(0, images.findIndex(image => image.att.key === key)),
      ),
    );
  };

  return (
    <Atts>
      {atts.map(att => (
        <AttachmentView key={att.key} att={att} onOpen={open} />
      ))}
    </Atts>
  );
}

function FeedMessage({ item, now }: { item: MessageItem; now: Date }) {
  const you = useAppSelector(selectUserName) ?? undefined;
  const dispatch = useAppDispatch();
  const ask = item.ask;
  const deciding = useAppSelector(s => (ask ? selectThreadCommandPending(s, ask.threadId, 'decide') : false));
  // An open question: its options as quick replies (the decision goes up
  // as COMMAND_THREAD decide; the outcome comes back with the tail — while
  // it is in flight the buttons are gone) and its link into the external
  // system (a sign-in is completed only by its link). A resolved one shows
  // the outcome under the text and who decided.
  const open = ask && ask.outcome === null && !deciding;
  const quick = open ? ask.options : undefined;
  const link = open && ask.link ? (ask.askKind === 'credential' ? { href: ask.link, label: 'Sign in', variant: 'primary' as const } : { href: ask.link, label: 'Open in the external system' }) : undefined;

  return (
    <Message
      agent={item.from}
      to={item.to}
      you={you}
      variant={item.variant}
      tag={ask ? askKindTag(ask.askKind) : item.tag}
      time={dateTimeLabel(item.at, now)}
      fold={item.fold}
      quick={quick}
      onQuick={reply => ask && dispatch(commandThread(ask.threadId, 'decide', undefined, { askId: ask.askId, decision: reply }))}
      link={link}
      decided={ask ? (askDecidedWords(ask, now) ?? undefined) : undefined}
    >
      {/* The user's own text keeps its single line breaks (typed, not
          Markdown-wrapped); an agent's Markdown reads by the usual rules. */}
      {item.text ? <Md source={item.text} breaks={item.variant === 'user'} /> : null}
      <Attachments atts={item.atts} context={`${item.from === 'you' ? (you ?? 'you') : item.from}${showsRecipient(item.from, item.to, item.tag, item.variant) ? ` → ${item.to}` : ''}, ${dateTimeLabel(item.at, now)}`} />
    </Message>
  );
}

function FeedChild({ item, now }: { item: ChildItem; now: Date }) {
  const live = useAppSelector(s => selectThreadState(s, item.threadId));
  const link = useLinkProps({ key: 'thread', id: item.threadId });
  const state = item.state ?? live ?? 'wait';
  const sub = item.startedAt
    ? `${item.agent} agent started · ${item.endedAt ? `${dateTimeLabel(item.startedAt, now)} → ${dateTimeLabel(item.endedAt, now)}` : dateTimeLabel(item.startedAt, now)}`
    : `${item.agent} agent · ended ${item.endedAt ? dateTimeLabel(item.endedAt, now) : ''}`;

  return (
    <ChildThread
      agent={item.agent}
      title={item.title}
      sub={sub}
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
    case 'thought':
      // Its time reads as an action's duration ("14s"); an unmeasured one has none.
      return <Thought time={item.durationMs === null ? undefined : actionDuration(item.durationMs)} source={item.text} />;
    case 'actions':
      return (
        <ActGroup fold={actFold(item.items)}>
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
          {item.plain ? item.text : <Code wrap>{item.text}</Code>}
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
