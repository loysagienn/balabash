// What the thread page says about the thread, in two places (design:
// ThreadRail, ThreadScreen sheet): the right rail of a wide thread —
// who (the agent, the parent thread that started it), the full title, the
// state and the tag, "Stop turn" / "Cancel thread" of an active thread,
// "Copy link"; then the session (model, engine), the context (the gauge of
// the latest session.context, compactions counted), the project and the
// time — and the same content as the bottom sheet "⋯" opens in a narrow
// thread. Child threads are cards in the feed.

import type { Thread } from '../../../core/contract.ts';
import type { StateName } from '../../ui/atoms/state.ts';
import { durationLabel, sinceLabel, startedLabel, timeOfDay } from '../../lib/format/index.ts';
import { Link } from '../../lib/router/Link.tsx';
import { writeRoute } from '../../lib/router/routes.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { Avatar } from '../../ui/Avatar/Avatar.tsx';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import type { KeyValueItem } from '../../ui/KeyValue/KeyValue.tsx';
import { Ctx } from '../../ui/Ring/Ctx.tsx';
import { formatTokensK } from '../../ui/Ring/Ring.logic.ts';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { RailGauge, RailSection, ThreadRail as Rail } from '../../ui/Thread/Thread.tsx';
import { threadStateLabel } from '../../ui/ThreadHead/ThreadHead.logic.ts';
import { isActiveState } from '../../ui/ThreadRow/ThreadRow.logic.ts';
import { Code, Tag } from '../../ui/atoms/atoms.tsx';
import { compactionsLabel } from './rail.ts';
import type { RailSessionInfo } from './rail.ts';

const LINK_WORDS = { done: 'Link copied', fail: 'Couldn’t copy the link' };

// The commands of an active thread with a parent, or null when it takes none.
export type ThreadDetailCommands = { onStop: () => void; stopBusy: boolean; stopDisabled: boolean; onCancel: () => void; cancelBusy: boolean };

export type ThreadDetailsProps = {
  thread: Thread;
  title: string;
  state: StateName;
  engine: string | null;
  info: RailSessionInfo;
  parent: Thread | null;
  project: { slug: string; title: string } | null;
  commands: ThreadDetailCommands | null;
  now: Date;
};

function useCopyLink(threadId: string): () => void {
  const copy = useCopy();

  return () => void copy(`${window.location.origin}${writeRoute({ key: 'thread', id: threadId })}`, LINK_WORDS);
}

function ParentLink({ parent }: { parent: Thread }) {
  return <Link route={{ key: 'thread', id: parent.id }}>{parent.agent}</Link>;
}

function engineWords(engine: string | null, info: RailSessionInfo): string | null {
  return engine ? (info.effort ? `${engine} · effort ${info.effort}` : engine) : null;
}

export function ThreadRail({ thread, title, state, engine, info, parent, project, commands, now }: ThreadDetailsProps) {
  const active = isActiveState(state);
  const copyLink = useCopyLink(thread.id);
  const percent = info.context ? (info.context.used / info.context.max) * 100 : null;
  const engineText = engineWords(engine, info);

  return (
    <Rail>
      <div className="th-rail-id">
        <div className="th-rail-who">
          <Avatar agent={thread.agent} />
          <span className="th-rail-who-main">
            <b className="th-rail-who-t">{thread.agent}</b>
            {parent ? (
              <span className="th-rail-who-m">
                from <ParentLink parent={parent} />
              </span>
            ) : null}
          </span>
          <IconBtn icon="link" label="Copy link" size="sm" onClick={copyLink} />
        </div>
        <h2 className="th-rail-t">{title}</h2>
        <div className="th-rail-st">
          <Badge state={state} label={threadStateLabel(state)} />
          {thread.headless ? <Tag>headless</Tag> : null}
        </div>
      </div>
      {commands ? (
        <div className="th-rail-acts">
          <Btn label="Stop turn" icon="pause" size="sm" block busy={commands.stopBusy} disabled={commands.stopDisabled} onClick={commands.onStop} />
          <Btn label="Cancel thread" icon="circle-stop" variant="danger" size="sm" block busy={commands.cancelBusy} onClick={commands.onCancel} />
        </div>
      ) : null}
      {info.model || engineText ? (
        <RailSection title="Session">
          <KeyValue
            items={[
              ...(info.model ? [{ key: 'model', value: <Code>{info.model}</Code> }] : []),
              ...(engineText ? [{ key: 'engine', value: engineText }] : []),
            ]}
          />
        </RailSection>
      ) : null}
      {info.context && percent !== null ? (
        <RailSection title={active ? 'Context' : 'Final context'}>
          <RailGauge value={percent}>
            {formatTokensK(info.context.used)} of {formatTokensK(info.context.max)} tokens
            <br />
            {compactionsLabel(info.compactions)}
          </RailGauge>
        </RailSection>
      ) : null}
      <RailSection title="Project and time">
        <KeyValue
          items={[
            ...(project ? [{ key: 'project', value: <Link route={{ key: 'project', slug: project.slug }}>{project.title}</Link> }] : []),
            { key: 'started', value: startedLabel(thread.createdAt, now) },
            active
              ? { key: 'running', value: durationLabel(now.getTime() - thread.createdAt.getTime()) }
              : { key: threadStateLabel(state), value: `${timeOfDay(thread.updatedAt)} · ${durationLabel(thread.updatedAt.getTime() - thread.createdAt.getTime())}` },
          ]}
        />
      </RailSection>
    </Rail>
  );
}

// The rail's content as a bottom sheet (a narrow thread's "⋯"): one list of
// facts, then the commands — "Stop turn", "Copy link", "Cancel thread".
export function ThreadDetailsSheet({ thread, title, state, engine, info, parent, project, commands, now, onClose }: ThreadDetailsProps & { onClose: () => void }) {
  const active = isActiveState(state);
  const copyLink = useCopyLink(thread.id);
  const engineText = engineWords(engine, info);
  const items: KeyValueItem[] = [
    {
      key: 'agent',
      value: parent ? (
        <>
          {thread.agent} · from <ParentLink parent={parent} />
        </>
      ) : (
        thread.agent
      ),
    },
    {
      key: 'state',
      value: (
        <>
          <Status state={state} label={threadStateLabel(state)} />
          {thread.headless ? <> <Tag>headless</Tag></> : null}
        </>
      ),
    },
    ...(info.model ? [{ key: 'model', value: <Code>{info.model}</Code> }] : []),
    ...(engineText ? [{ key: 'engine', value: engineText }] : []),
    ...(info.context && info.context.max > 0
      ? [
          {
            key: 'context',
            value: (
              <Ctx
                percentage={(info.context.used / info.context.max) * 100}
                text={`${Math.round((info.context.used / info.context.max) * 100)}% · ${formatTokensK(info.context.used)} of ${formatTokensK(info.context.max)} · ${compactionsLabel(info.compactions)}`}
              />
            ),
          },
        ]
      : []),
    ...(project ? [{ key: 'project', value: <Link route={{ key: 'project', slug: project.slug }}>{project.title}</Link> }] : []),
    active
      ? { key: 'running', value: `${sinceLabel(thread.createdAt, now)} · ${durationLabel(now.getTime() - thread.createdAt.getTime())}` }
      : { key: threadStateLabel(state), value: `${startedLabel(thread.createdAt, now)} → ${timeOfDay(thread.updatedAt)} · ${durationLabel(thread.updatedAt.getTime() - thread.createdAt.getTime())}` },
  ];

  return (
    <Sheet label="Thread details" title={title} onClose={onClose}>
      <div className="ths-sheet">
        <KeyValue items={items} />
        {commands ? (
          <Btn
            label="Stop turn"
            icon="pause"
            block
            busy={commands.stopBusy}
            disabled={commands.stopDisabled}
            onClick={() => {
              onClose();
              commands.onStop();
            }}
          />
        ) : null}
        <Btn
          label="Copy link"
          icon="link"
          variant="ghost"
          block
          onClick={() => {
            onClose();
            copyLink();
          }}
        />
        {commands ? (
          <Btn
            label="Cancel thread"
            icon="circle-stop"
            variant="danger"
            block
            busy={commands.cancelBusy}
            onClick={() => {
              onClose();
              commands.onCancel();
            }}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
