// What the thread page says about the thread, in two places (design:
// ThreadRail, ThreadScreen sheet): the right rail of a wide thread —
// who (the agent, the parent thread that started it), the full title, the
// state and the tags (a note under them for a remote thread asleep or
// closed), the controls of an active child thread in two groups — the
// turn (Stop turn; remote: Stop turn · Pause side by side), the thread
// (Finish thread / Finish requested with its note, Cancel thread as
// danger-line: the confirmation's own button is the tinted danger) —
// regular-size buttons, full width; a control that does not apply stays,
// disabled, so the rail never reflows;
// "Copy link"; then the session (model, engine), the context (the gauge of
// the latest session.context, compactions counted; a remote thread has
// none), the project and the time — and the same content as the bottom
// sheet "⋯" opens in a narrow thread. Child threads are cards in the feed.

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
import { finishNote, stateNote } from './ThreadScreen.logic.ts';

const LINK_WORDS = { done: 'Link copied', fail: 'Couldn’t copy the link' };

// The commands of an active thread with a parent, or null when it takes none.
export type ThreadDetailCommands = {
  onStop: () => void;
  stopBusy: boolean;
  // No turn in flight to stop (the session waits) — the button stays, inert.
  stopDisabled: boolean;
  // A remote thread's own: pause, enabled only while the session awaits a
  // message (and no finish was asked); absent for a local thread.
  pause: { onClick: () => void; busy: boolean; disabled: boolean } | null;
  // Finish: the agent is asked to wrap up and end the thread itself (a
  // remote session — for its closing summary).
  onFinish: () => void;
  finishBusy: boolean;
  // When a finish was already asked (the thread.finish event's time): the
  // agent is wrapping up — the button reads "Finish requested", disabled,
  // and a note says what happens next.
  finishAsked: Date | null;
  onCancel: () => void;
  cancelBusy: boolean;
};

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
  const note = stateNote(thread, state);

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
          {thread.remote ? <Tag>remote</Tag> : null}
        </div>
        {note ? <p className="th-rail-note">{note}</p> : null}
      </div>
      {commands ? (
        <div className="th-rail-acts">
          <div className="th-rail-turn" data-split={commands.pause ? '' : undefined}>
            <Btn label="Stop turn" icon="square" block busy={commands.stopBusy} disabled={commands.stopDisabled} onClick={commands.onStop} />
            {commands.pause ? <Btn label="Pause" icon="moon" block busy={commands.pause.busy} disabled={commands.pause.disabled} onClick={commands.pause.onClick} /> : null}
          </div>
          <div className="th-rail-end">
            {commands.finishAsked ? (
              <Btn label="Finish requested" icon="hourglass" block disabled />
            ) : (
              <Btn label="Finish thread" icon="flag" block busy={commands.finishBusy} onClick={commands.onFinish} />
            )}
            <Btn label="Cancel thread" icon="circle-stop" variant="danger-line" block busy={commands.cancelBusy} onClick={commands.onCancel} />
            {commands.finishAsked ? <p className="th-rail-note">{finishNote(thread, commands.finishAsked)}</p> : null}
          </div>
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
      {info.context && percent !== null && !thread.remote ? (
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
// facts, the note of a finish asked or a thread asleep, then the full set
// of commands — "Stop turn", "Pause" (remote), "Finish thread" / "Finish
// requested", "Copy link", "Cancel thread" (the ones that do not apply
// shown disabled, as in the rail).
export function ThreadDetailsSheet({ thread, title, state, engine, info, parent, project, commands, now, onClose }: ThreadDetailsProps & { onClose: () => void }) {
  const active = isActiveState(state);
  const copyLink = useCopyLink(thread.id);
  const engineText = engineWords(engine, info);
  const note = commands?.finishAsked ? finishNote(thread, commands.finishAsked) : state === 'paused' ? stateNote(thread, state) : null;
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
          {thread.remote ? <> <Tag>remote</Tag></> : null}
        </>
      ),
    },
    ...(info.model ? [{ key: 'model', value: <Code>{info.model}</Code> }] : []),
    ...(engineText ? [{ key: 'engine', value: engineText }] : []),
    ...(info.context && info.context.max > 0 && !thread.remote
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
  // A command closes the sheet first: the confirmation or the outcome
  // shows on the page.
  const then = (command: () => void) => () => {
    onClose();
    command();
  };

  return (
    <Sheet label="Thread details" title={title} onClose={onClose}>
      <div className="ths-sheet">
        <KeyValue items={items} />
        {note ? <p className="th-rail-note">{note}</p> : null}
        {commands ? <Btn label="Stop turn" icon="square" block busy={commands.stopBusy} disabled={commands.stopDisabled} onClick={then(commands.onStop)} /> : null}
        {commands?.pause ? <Btn label="Pause" icon="moon" block busy={commands.pause.busy} disabled={commands.pause.disabled} onClick={then(commands.pause.onClick)} /> : null}
        {commands ? (
          commands.finishAsked ? (
            <Btn label="Finish requested" icon="hourglass" block disabled />
          ) : (
            <Btn label="Finish thread" icon="flag" block busy={commands.finishBusy} onClick={then(commands.onFinish)} />
          )
        ) : null}
        <Btn label="Copy link" icon="link" variant="ghost" block onClick={then(copyLink)} />
        {commands ? <Btn label="Cancel thread" icon="circle-stop" variant="danger-line" block busy={commands.cancelBusy} onClick={then(commands.onCancel)} /> : null}
      </div>
    </Sheet>
  );
}
