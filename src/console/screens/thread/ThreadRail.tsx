// The details column of the thread page (design: .th-rail): the session
// (state, model and engine from session.started), the context (the gauge
// of the latest session.context in the feed, compactions counted), the
// links to the parent and the child threads, the project and the time.

import type { Thread } from '../../../core/contract.ts';
import type { StateName } from '../../ui/atoms/state.ts';
import { durationLabel, startedLabel, timeOfDay } from '../../lib/format/index.ts';
import { Link, useLinkProps } from '../../lib/router/Link.tsx';
import { useAppSelector } from '../../store/hooks.ts';
import { selectThreadState } from '../../store/sessions/selectors.ts';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { RailLink } from '../../ui/RailLink/RailLink.tsx';
import { formatTokensK } from '../../ui/Ring/Ring.logic.ts';
import { compactionsLabel } from './rail.ts';
import type { RailSessionInfo } from './rail.ts';
import { Status } from '../../ui/Status/Status.tsx';
import { RailGauge, RailSection, ThreadRail as Rail } from '../../ui/Thread/Thread.tsx';
import { threadStateLabel } from '../../ui/ThreadHead/ThreadHead.logic.ts';
import { isActiveState } from '../../ui/ThreadRow/ThreadRow.logic.ts';
import { Code } from '../../ui/atoms/atoms.tsx';

function ChildLink({ id }: { id: string }) {
  const child = useAppSelector(s => s.threads.byId[id]);
  const state = useAppSelector(s => selectThreadState(s, id)) ?? 'wait';
  const link = useLinkProps({ key: 'thread', id });

  if (!child) {
    return null;
  }

  return <RailLink agent={child.agent} text={child.title?.trim() || child.agent} state={state} href={link.href} onClick={link.onClick} />;
}

export type ThreadRailProps = {
  thread: Thread;
  state: StateName;
  engine: string | null;
  info: RailSessionInfo;
  parent: Thread | null;
  mainThreadId: string | null;
  childIds: string[];
  project: { slug: string; title: string } | null;
  now: Date;
};

export function ThreadRail({ thread, state, engine, info, parent, mainThreadId, childIds, project, now }: ThreadRailProps) {
  const active = isActiveState(state);
  const parentLink = useLinkProps({ key: 'thread', id: parent?.id ?? '' });
  const parentText = parent ? (parent.id === mainThreadId ? `${parent.agent} · main thread` : parent.title?.trim() || parent.agent) : null;
  const percent = info.context ? (info.context.used / info.context.max) * 100 : null;

  return (
    <Rail>
      <RailSection title="Session">
        <KeyValue
          items={[
            { key: 'state', value: <Status state={state} label={threadStateLabel(state)} /> },
            ...(info.model ? [{ key: 'model', value: <Code>{info.model}</Code> }] : []),
            ...(engine ? [{ key: 'engine', value: info.effort ? `${engine} · effort ${info.effort}` : engine }] : []),
          ]}
        />
      </RailSection>
      {info.context && percent !== null ? (
        <RailSection title={active ? 'Context' : 'Final context'}>
          <RailGauge value={percent}>
            {formatTokensK(info.context.used)} of {formatTokensK(info.context.max)} tokens
            <br />
            {compactionsLabel(info.compactions)}
          </RailGauge>
        </RailSection>
      ) : null}
      {parent || childIds.length > 0 ? (
        <RailSection title="Links">
          {parent && parentText ? <RailLink agent={parent.agent} text={parentText} up href={parentLink.href} onClick={parentLink.onClick} /> : null}
          {childIds.map(id => (
            <ChildLink key={id} id={id} />
          ))}
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
