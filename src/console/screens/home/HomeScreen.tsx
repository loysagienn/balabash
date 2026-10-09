// Home — the overview: the threads at work, every app, links to the
// sections; on the right, the projects in work. Everything on the screen is
// the snapshot and its tail: no request of its own. The columns dissolve on
// the phone and the cards line up by importance (HomeScreen.css). The
// subscription limits card comes with GET /api/limits (plan, stage 6).

import { useRef } from 'react';
import type { AppListingView, ProjectView } from '../../../api/contract.ts';
import { Link, useLinkProps } from '../../lib/router/Link.tsx';
import { agoLabel, clockLabel, countOf } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectConnections, selectConnectionsNeedingAction } from '../../store/connections/selectors.ts';
import { selectActiveProjects, selectArchivedProjectCount, selectProjects } from '../../store/projects/selectors.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectLatestFinishedThread, selectRunningCountByProject, selectRunningThreads } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { NAV } from '../../features/shell/nav.ts';
import { ThreadList } from '../../features/thread-list/ThreadList.tsx';
import { AppRow } from '../../ui/AppRow/AppRow.tsx';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Card, CardBody, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Grid12, Grid12Col } from '../../ui/Grid12/Grid12.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SectionLink, SectionLinks } from '../../ui/SectionLink/SectionLink.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { appLink, appTitle, appUrlText } from '../../features/apps/appLink.ts';
import { nothingRunningNote, sectionSummary } from './HomeScreen.logic.ts';
import './HomeScreen.css';

// The projects card shows the most recently touched; the rest are a link away.
const HOME_PROJECTS = 6;
const CLOCK_MS = 15_000;

function Skeleton({ widths }: { widths: number[][] }) {
  return (
    <List narrow="tiles" busy>
      {widths.map((w, i) => (
        <SkelRow key={i} widths={w} />
      ))}
    </List>
  );
}

function ProjectRow({ project, running, now }: { project: ProjectView; running: number; now: Date }) {
  const link = useLinkProps({ key: 'project', slug: project.slug });

  return (
    <Row
      {...link}
      lead={<Obj icon="folder" size="md" />}
      title={project.title}
      meta={project.description || undefined}
      end={
        <>
          {running > 0 ? <Badge state="run" label={countOf(running, 'thread')} size="sm" /> : null}
          <span className="row-time">{agoLabel(project.updatedAt, now)}</span>
        </>
      }
    />
  );
}

// A published app opens itself in a new tab; one without an address or
// with a broken manifest leads to the Apps section, where it is managed
// (appLink).
function HomeAppRow({ app, base }: { app: AppListingView; base: string }) {
  const section = useLinkProps({ key: 'apps' });
  const { address, href } = appLink(app, base);
  const common = { title: appTitle(app), desc: app.description ?? undefined, err: app.manifestError ?? undefined, url: address === null ? undefined : appUrlText(address) };

  return href ? <AppRow {...common} appHref={href} href={href} external /> : <AppRow {...common} {...section} />;
}

function HomeSectionLink({ item, meta, state }: { item: (typeof NAV)[number]; meta?: string; state?: 'act' }) {
  const link = useLinkProps(item.route);

  return <SectionLink icon={item.icon} title={item.name} meta={meta} state={state} {...link} />;
}

export function HomeScreen() {
  const dispatch = useAppDispatch();
  const now = useNow();
  const clock = useNow(CLOCK_MS);
  const stream = useAppSelector(selectStream);
  const running = useAppSelector(selectRunningThreads);
  const lastFinished = useAppSelector(selectLatestFinishedThread);
  const runningByProject = useAppSelector(selectRunningCountByProject);
  const projects = useAppSelector(selectProjects);
  const activeProjects = useAppSelector(selectActiveProjects);
  const archivedProjects = useAppSelector(selectArchivedProjectCount);
  const apps = useAppSelector(s => s.apps.items);
  const appsBase = useAppSelector(s => s.apps.publicAppsBase);
  const tasks = useAppSelector(s => s.schedule.tasks);
  const taskIds = useAppSelector(s => s.schedule.ids);
  const connections = useAppSelector(selectConnections);
  const needingAction = useAppSelector(selectConnectionsNeedingAction);
  const agentNames = useAppSelector(s => s.agents.names);
  const streamSeq = stream.lastSeq ?? stream.asOfSeq;

  // Rows above this seq are new to the screen: it opened with the store at streamSeq.
  const mountSeq = useRef<bigint | null>(null);

  if (mountSeq.current === null && streamSeq !== null) {
    mountSeq.current = streamSeq;
  }

  const stage = snapshotStage(stream);
  const loading = stage === 'loading';
  const offline = stage === 'ready' && stream.status === 'reconnecting';

  let nextRunAt: Date | null = null;

  for (const id of taskIds) {
    const at = tasks[id]?.nextRunAt ?? null;

    if (at !== null && (nextRunAt === null || at < nextRunAt)) {
      nextRunAt = at;
    }
  }

  const counts = {
    running: running.length,
    projects: projects.length,
    archivedProjects,
    apps: apps.length,
    publishedApps: apps.filter(app => app.slug !== null).length,
    tasks: taskIds.length,
    nextRunAt,
    connections: connections.length,
    connectionsNeedingAction: needingAction.length,
    agents: agentNames.length,
    now,
  };

  if (stage === 'failed') {
    return (
      <Shell current="home" title="Home" sub={clockLabel(clock)}>
        <Screen>
          <Card narrow="bare">
            <Empty icon="cloud-off" state="err" title="Couldn’t load the overview" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
              {stream.snapshot.error?.message}
            </Empty>
          </Card>
        </Screen>
      </Shell>
    );
  }

  return (
    <Shell current="home" title="Home" sub={clockLabel(clock)}>
      <Screen>
        {offline ? (
          <Note state="err" icon="cloud-off" role="alert">
            No connection to the server. The data on screen may be behind; reconnecting…
          </Note>
        ) : null}
        <Grid12>
          <Grid12Col span={8} stack className="home-col">
            <Card narrow="bare" className="home-o1">
              <CardHead
                title="Active threads"
                count={loading ? undefined : running.length}
                countState="run"
                link={
                  <Link className="link" route={{ key: 'threads', status: 'active' }}>
                    All threads
                  </Link>
                }
              />
              {loading ? (
                <Skeleton widths={[[62, 38], [48, 30], [55, 42]]} />
              ) : running.length > 0 ? (
                <ThreadList className="home-ths" threads={running} now={now} freshAfter={mountSeq.current} flat />
              ) : (
                <Empty icon="messages-square" title="Nothing is running">
                  {nothingRunningNote(lastFinished, now)}
                </Empty>
              )}
            </Card>
            <Card narrow="bare" className="home-o4">
              <CardHead title="Apps" count={loading ? undefined : apps.length} />
              {loading ? (
                <Skeleton widths={[[62, 38], [48, 30], [55, 42]]} />
              ) : apps.length > 0 ? (
                <List narrow="tiles">
                  {apps.map(app => (
                    <HomeAppRow key={app.path} app={app} base={appsBase} />
                  ))}
                </List>
              ) : (
                <Empty icon="layout-grid" title="No apps yet">
                  Ask an agent to build a tracker, dashboard or form — it will show up here.
                </Empty>
              )}
            </Card>
            <Card narrow="bare" className="home-o5">
              <CardHead title="Sections" />
              <CardBody>
                <SectionLinks narrow="tiles">
                  {NAV.filter(item => item.key !== 'home').map(item => {
                    const summary = loading ? null : sectionSummary(item.key, counts);

                    return <HomeSectionLink key={item.key} item={item} meta={summary?.meta} state={summary?.state} />;
                  })}
                </SectionLinks>
              </CardBody>
            </Card>
          </Grid12Col>
          <Grid12Col span={4} stack className="home-col">
            <Card narrow="bare" className="home-o3">
              <CardHead
                title="Active projects"
                link={
                  <Link className="link" route={{ key: 'projects' }}>
                    {loading ? 'All' : `All · ${activeProjects.length}`}
                  </Link>
                }
              />
              {loading ? (
                <Skeleton widths={[[62, 38], [48, 30]]} />
              ) : activeProjects.length > 0 ? (
                <List narrow="tiles">
                  {activeProjects.slice(0, HOME_PROJECTS).map(project => (
                    <ProjectRow key={project.id} project={project} running={runningByProject[project.id] ?? 0} now={now} />
                  ))}
                </List>
              ) : (
                <Empty icon="folder" title="No projects yet">
                  A project is a folder with AGENTS.md; ask an agent to start one.
                </Empty>
              )}
            </Card>
          </Grid12Col>
        </Grid12>
      </Screen>
    </Shell>
  );
}
