// Agents — the catalog from the snapshot and the selected agent: its
// settings (engine, model, effort, mode, whom it launches), its tool
// servers (the passport names the servers, not the single tools) and its
// activity — the threads of the agent the store knows, active first, under
// the agent's whole count and its count of the last 30 days, read by place
// (features/thread-list/queries.ts — the store holds only a window).
// A split view: the catalog beside the details when wide, one of them on
// the phone (the selected agent is a detail screen there). The selection
// and the search are the route. The catalog and the threads are the
// snapshot and its tail; the two counts are the one request of the
// screen (a failed one is named in the section's header with its own
// Retry). A failed first snapshot replaces
// the split view (Home does the same): the error and Retry must be in
// sight on the phone too, where the named agent hides the catalog.

import { useMemo } from 'react';
import type { AgentView } from '../../../api/contract.ts';
import type { AgentsRoute } from '../../lib/router/routes.ts';
import { Link, useLinkProps, useLinkTargets } from '../../lib/router/Link.tsx';
import { countOf } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { agentOf } from '../../store/agents/selectors.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { makeSelectAgentThreads, selectRunningCount, selectRunningCountByAgent } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { ThreadList } from '../../features/thread-list/ThreadList.tsx';
import { useThreadTotal } from '../../features/thread-list/queries.ts';
import { TotalFailure } from '../../features/thread-list/TotalFailure.tsx';
import { knownTotal, recentSince } from '../../features/thread-list/totals.ts';
import { Avatar } from '../../ui/Avatar/Avatar.tsx';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Skel, SkelRow, SkelStack } from '../../ui/Skel/Skel.tsx';
import { DetailSection, Split, SplitDetail, SplitList } from '../../ui/Split/Split.tsx';
import { Code, Quiet, Tag } from '../../ui/atoms/atoms.tsx';
import { engineLabel, engineName } from '../../lib/format/engine.ts';
import { activityCaption, agentMatches, agentsDetail, agentsShell, agentsSummary, catalogModel, effortWords, emptyActivity, modeLabel, modelWords, withAgentsFilters } from './AgentsScreen.logic.ts';
import './AgentsScreen.css';

// The activity shows the newest threads; the rest are a link away.
const AGENT_THREADS = 8;
const SKELETON = [[55, 70], [40, 62], [48, 75], [36, 58]];

function Who({ name }: { name: string }) {
  const link = useLinkProps({ key: 'agents', name });

  return (
    <a className="agt-who" {...link}>
      <Avatar agent={name} size="xs" />
      {name}
    </a>
  );
}

// A setting of the details: the value in code (a model id) or plain (an
// effort), the quiet note on where it comes from beside it.
function Setting({ value, note, code }: { value: string | null; note: string | null; code?: boolean }) {
  return (
    <span className="agt-setting">
      {value ? code ? <Code>{value}</Code> : value : null}
      {note ? <Quiet>{note}</Quiet> : null}
    </span>
  );
}

function AgentDetail({ agent, running }: { agent: AgentView; running: number }) {
  const now = useNow();
  const model = modelWords(agent);
  const effort = effortWords(agent);
  const selectThreads = useMemo(makeSelectAgentThreads, []);
  const threads = useAppSelector(s => selectThreads(s, agent.name));
  // The counts of the agent's threads — all time and the recent window —
  // from the server, brought up to the tail the store has folded since; a
  // request that stands in error has no number, whatever Query kept.
  const since = recentSince(now);
  const all = useThreadTotal({ agent: agent.name });
  const recent = useThreadTotal({ agent: agent.name, createdAtGte: since.toISOString() });
  const whole = knownTotal(all, threads);
  const caption = activityCaption(whole, knownTotal(recent, threads, since), running);
  // A request that failed takes the caption's place with its Retry: the
  // number it would complete is not known, and a stale one would pass for
  // current.
  const failed = all.isError || recent.isError;
  // An empty activity says whether the agent has no threads or none recent.
  const empty = emptyActivity(agent.name, whole);

  return (
    <Card narrow="bare">
      <DetailSection>
        <div className="agt-head">
          <Avatar agent={agent.name} size="lg" className="agt-head-av" />
          <h3 className="card-t">{agent.name}</h3>
          <span className="agt-desc">{agent.description}</span>
        </div>
        <KeyValue
          items={[
            { key: 'engine', value: engineName(agent.sdk) },
            { key: 'model', value: <Setting value={model.value} note={model.note} code /> },
            { key: 'effort', value: <Setting value={effort.value} note={effort.note} /> },
            { key: 'mode', value: modeLabel(agent.headless) },
            {
              key: 'launches',
              value:
                agent.agents.length > 0 ? (
                  <span className="agt-chips">
                    {agent.agents.map(name => (
                      <Who key={name} name={name} />
                    ))}
                  </span>
                ) : (
                  <Quiet>no sub-agents</Quiet>
                ),
            },
          ]}
        />
      </DetailSection>
      <DetailSection title={`Tool servers · ${agent.tools.length}`}>
        {agent.tools.length > 0 ? (
          <div className="agt-chips">
            {agent.tools.map(tool => (
              <Code key={tool}>{tool}</Code>
            ))}
          </div>
        ) : (
          <Quiet>no tool servers</Quiet>
        )}
      </DetailSection>
      <DetailSection title="Activity" end={failed ? <TotalFailure queries={[all, recent]} /> : caption ? <Quiet>{caption}</Quiet> : undefined}>
        {threads.length > 0 ? (
          <ThreadList className="agt-list" threads={threads.slice(0, AGENT_THREADS)} now={now} noAgent flat />
        ) : (
          <Empty icon="messages-square" title={empty.title}>
            {empty.note}
          </Empty>
        )}
        <Link className="link" route={{ key: 'threads', agent: agent.name }}>
          All {agent.name} threads
        </Link>
      </DetailSection>
    </Card>
  );
}

export function AgentsScreen({ route }: { route: AgentsRoute }) {
  const dispatch = useAppDispatch();
  const stream = useAppSelector(selectStream);
  const names = useAppSelector(s => s.agents.names);
  const byName = useAppSelector(s => s.agents.byName);
  const running = useAppSelector(selectRunningCount);
  const runningByAgent = useAppSelector(selectRunningCountByAgent);
  const linkTarget = useLinkTargets();
  const shell = agentsShell(route);
  const stage = snapshotStage(stream);
  const go = (patch: Parameters<typeof withAgentsFilters>[1]) => dispatch(routeTo(withAgentsFilters(route, patch), { replace: true }));
  const agents = names.map(name => byName[name]).filter((agent): agent is AgentView => agent !== undefined);
  const visible = agents.filter(agent => agentMatches(agent, route.q));
  const selected = route.name ? agentOf(byName, route.name) : null;
  const detailStage = agentsDetail(route.name, selected !== null, stage);

  let catalog;

  if (stage === 'loading') {
    catalog = (
      <List className="agt-list" narrow="tiles" busy>
        {SKELETON.map((w, i) => (
          <SkelRow key={i} widths={w} />
        ))}
      </List>
    );
  } else if (visible.length === 0) {
    catalog = route.q ? (
      <Empty icon="bot" title="No agents match" action="Clear search" onAction={() => go({ q: undefined })}>
        No agent is named or described like “{route.q}”.
      </Empty>
    ) : (
      <Empty icon="bot" title="No agents">
        The catalog of this build is empty.
      </Empty>
    );
  } else {
    catalog = (
      <List className="agt-list" narrow="tiles">
        {visible.map(agent => {
          const active = runningByAgent[agent.name] ?? 0;

          return (
            <Row
              key={agent.name}
              {...linkTarget(withAgentsFilters(route, { name: agent.name }))}
              current={agent.name === route.name}
              lead={<Avatar agent={agent.name} pip={active > 0 ? 'run' : undefined} />}
              title={
                <>
                  {agent.name}
                  {agent.headless ? <Tag>headless</Tag> : null}
                </>
              }
              meta={agent.description}
              end={
                <>
                  {active > 0 ? <Badge state="run" label={`${active} active`} size="sm" /> : null}
                  <span className="row-time">
                    {engineLabel(agent.sdk)}
                    <small className="row-time-sub">{catalogModel(agent)}</small>
                  </span>
                </>
              }
            />
          );
        })}
      </List>
    );
  }

  let detail;

  if (detailStage === 'agent' && selected) {
    detail = <AgentDetail key={selected.name} agent={selected} running={runningByAgent[selected.name] ?? 0} />;
  } else if (detailStage === 'unknown') {
    detail = (
      <Card narrow="bare">
        <Empty icon="bot" title={`No agent named “${route.name}”`} action="All agents" onAction={() => go({ name: undefined })}>
          It is not in the catalog of this build; its threads, if any, are under Threads.
        </Empty>
      </Card>
    );
  } else if (detailStage === 'pick') {
    detail = (
      <Card narrow="bare">
        <Empty icon="bot" title="Pick an agent">
          Its settings, tools and activity show here.
        </Empty>
      </Card>
    );
  } else {
    detail = (
      <Card narrow="bare" label="Loading the agent">
        <DetailSection>
          <div className="agt-head" aria-hidden="true">
            <Skel shape="av" />
            <SkelStack widths={[32, 70]} />
          </div>
        </DetailSection>
        <DetailSection>
          <span aria-hidden="true">
            <SkelStack widths={[48, 36, 54, 40]} smFirst />
          </span>
        </DetailSection>
      </Card>
    );
  }

  const body =
    stage === 'failed' ? (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load the agents" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
          {stream.snapshot.error?.message}
        </Empty>
      </Card>
    ) : (
      <Split view={route.name ? 'detail' : 'list'}>
        <SplitList>
          <FBar
            filters={<Quiet>{stage === 'ready' ? agentsSummary(agents.length, running) : '—'}</Quiet>}
            search={
              <Input
                value={route.q ?? ''}
                onChange={q => go({ q })}
                placeholder="Search agents"
                lead="search"
                ariaLabel="Search agents"
                end={route.q ? <IconBtn icon="x" label="Clear" size="sm" onClick={() => go({ q: undefined })} /> : undefined}
              />
            }
          />
          <Card narrow="bare">{catalog}</Card>
        </SplitList>
        <SplitDetail>{detail}</SplitDetail>
      </Split>
    );

  return (
    <Shell current="agents" title={shell.title} titleNarrow={shell.titleNarrow} back={shell.back} backNarrow={shell.backNarrow} detail={shell.detail}>
      <Screen>{body}</Screen>
    </Shell>
  );
}
