// Agents — the catalog from the snapshot and the selected agent: its
// settings (engine, model, effort, mode, whom it launches), its tool
// servers (the passport names the servers, not the single tools) and its
// activity — the threads of the agent the store knows, active first.
// A split view: the catalog beside the details when wide, one of them on
// the phone (the selected agent is a detail screen there). The selection
// and the search are the route. Nothing is requested: the catalog and the
// threads are the snapshot and its tail.

import { useMemo } from 'react';
import type { AgentView } from '../../../api/contract.ts';
import type { AgentsRoute } from '../../lib/router/routes.ts';
import { Link, useLinkProps, useLinkTargets } from '../../lib/router/Link.tsx';
import { countOf } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { makeSelectAgentThreads, selectRunningCount, selectRunningCountByAgent } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { ThreadList } from '../../features/thread-list/ThreadList.tsx';
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
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { DetailSection, Split, SplitDetail, SplitList } from '../../ui/Split/Split.tsx';
import { Code, Quiet, Tag } from '../../ui/atoms/atoms.tsx';
import { agentMatches, agentsShell, agentsSummary, engineLabel, engineName, modeLabel, withAgentsFilters } from './AgentsScreen.logic.ts';
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

function AgentDetail({ agent, running }: { agent: AgentView; running: number }) {
  const now = useNow();
  const selectThreads = useMemo(makeSelectAgentThreads, []);
  const threads = useAppSelector(s => selectThreads(s, agent.name));

  return (
    <Card narrow="bare">
      <DetailSection>
        <div className="agt-head">
          <Avatar agent={agent.name} size="lg" />
          <h3 className="card-t">{agent.name}</h3>
          <span className="agt-desc">{agent.description}</span>
        </div>
        <KeyValue
          items={[
            { key: 'engine', value: engineName(agent.sdk) },
            { key: 'model', value: agent.model ? <Code>{agent.model}</Code> : <Quiet>default of the engine</Quiet> },
            { key: 'effort', value: agent.effort ?? <Quiet>default of the engine</Quiet> },
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
      <DetailSection title="Activity" end={running > 0 ? <Quiet>{`${running} running`}</Quiet> : undefined}>
        {threads.length > 0 ? (
          <ThreadList className="agt-list" threads={threads.slice(0, AGENT_THREADS)} now={now} noAgent flat />
        ) : (
          <Empty icon="messages-square" title="No threads yet">
            Threads of {agent.name} appear here as it works.
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
  const selected = route.name ? (byName[route.name] ?? null) : null;

  let catalog;

  if (stage === 'loading') {
    catalog = (
      <List className="agt-list" narrow="tiles" busy>
        {SKELETON.map((w, i) => (
          <SkelRow key={i} widths={w} />
        ))}
      </List>
    );
  } else if (stage === 'failed') {
    catalog = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the agents" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
        {stream.snapshot.error?.message}
      </Empty>
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
                    <small className="row-time-sub">{agent.model ?? 'default model'}</small>
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

  if (selected) {
    detail = <AgentDetail key={selected.name} agent={selected} running={runningByAgent[selected.name] ?? 0} />;
  } else if (route.name && stage === 'ready') {
    detail = (
      <Card narrow="bare">
        <Empty icon="bot" title={`No agent named “${route.name}”`} action="All agents" onAction={() => go({ name: undefined })}>
          It is not in the catalog of this build; its threads, if any, are under Threads.
        </Empty>
      </Card>
    );
  } else if (!route.name) {
    detail = (
      <Card narrow="bare">
        <Empty icon="bot" title="Pick an agent">
          Its settings, tools and activity show here.
        </Empty>
      </Card>
    );
  } else {
    detail = null;
  }

  return (
    <Shell current="agents" title={shell.title} titleNarrow={shell.titleNarrow} back={shell.back} backNarrow={shell.backNarrow} detail={shell.detail}>
      <Screen>
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
      </Screen>
    </Shell>
  );
}
