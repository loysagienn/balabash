// Schedule — the cron and one-off tasks of the workspace and their run
// journal. Two tabs in the filter bar: the tasks (with a search) and the
// run log. The tasks are the snapshot and its tail (store/schedule); a
// split view — the list beside the selected task when wide, one of them
// on the phone (the task is a detail screen there); the selection, the
// tab and the search are the route. Each row: the kind, the schedule
// spelled out with its expression, the last run (the newest run of every
// command job, read by place — a reminder or a code task has no journal)
// and the next run, recomputed in the schedule's time zone (next-run.ts;
// the zone comes with the Settings facts). A failed first snapshot
// replaces the split view: the error and Retry must be in sight on the
// phone too, where the named task hides the list.

import type { MouseEvent } from 'react';
import type { JobRunView, TaskView } from '../../../api/contract.ts';
import type { ScheduleRoute } from '../../lib/router/routes.ts';
import { useLinkTargets } from '../../lib/router/Link.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { selectTasks } from '../../store/schedule/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { useSettingsFacts } from '../settings/queries.ts';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelRow, SkelStack } from '../../ui/Skel/Skel.tsx';
import { DetailSection, Split, SplitDetail, SplitList } from '../../ui/Split/Split.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { Tab, Tabs } from '../../ui/Tabs/Tabs.tsx';
import { Code, Quiet, Tag } from '../../ui/atoms/atoms.tsx';
import { RunLog } from './RunLog.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { kindWords, lastRunWords, orderTasks, scheduleDetail, scheduleShell, taskMatches, triggerWords, whenLabel, withScheduleFilters } from './ScheduleScreen.logic.ts';
import { nextRunOf } from './next-run.ts';
import { useLatestJobRuns } from './queries.ts';
import './ScheduleScreen.css';

const SKELETON = [[55, 70], [40, 62], [48, 75], [36, 58]];

export function ScheduleScreen({ route }: { route: ScheduleRoute }) {
  const dispatch = useAppDispatch();
  const stream = useAppSelector(selectStream);
  const tasks = useAppSelector(selectTasks);
  const linkTarget = useLinkTargets();
  const now = useNow();
  const stage = snapshotStage(stream);
  const facts = useSettingsFacts();
  const timezone = facts.data?.scheduleTimezone ?? null;
  const latest = useLatestJobRuns(stage === 'ready');
  // The last run of a task: a row of the latest runs, null when the journal
  // knows none, undefined while the journal has not answered (nothing is
  // claimed then — "not run yet" would be a guess).
  const lastRunOf = (slug: string) => (latest.data ? (latest.data.find(run => run.slug === slug) ?? null) : undefined);
  const go = (patch: Parameters<typeof withScheduleFilters>[1]) => dispatch(routeTo(withScheduleFilters(route, patch), { replace: true }));
  const selected = route.slug ? (tasks.find(task => task.slug === route.slug) ?? null) : null;
  const shell = scheduleShell(route, selected);
  const detailStage = scheduleDetail(route.slug, selected !== null, stage);
  const log = route.tab === 'log';
  const withNext = tasks.map(task => ({ task, nextRunAt: nextRunOf(task, now, timezone) }));
  const visible = orderTasks(withNext.filter(({ task }) => taskMatches(task, route.q)).map(({ task, nextRunAt }) => ({ task, nextRunAt })));

  const bar = (
    <FBar
      filters={
        <Tabs label="Schedule">
          <Tab label="Tasks" n={stage === 'ready' ? tasks.length : undefined} sel={!log} onClick={() => go({ tab: undefined, task: undefined })} />
          <Tab label="Run log" sel={log} onClick={() => go({ tab: 'log', q: undefined })} />
        </Tabs>
      }
      search={
        log ? undefined : (
          <Input
            value={route.q ?? ''}
            onChange={q => go({ q })}
            placeholder="Search tasks"
            lead="search"
            ariaLabel="Search tasks"
            end={route.q ? <IconBtn icon="x" label="Clear" size="sm" onClick={() => go({ q: undefined })} /> : undefined}
          />
        )
      }
    />
  );

  let list;

  if (stage === 'loading') {
    list = (
      <List className="sch-list" narrow="tiles" busy>
        {SKELETON.map((w, i) => (
          <SkelRow key={i} widths={w} />
        ))}
      </List>
    );
  } else if (tasks.length === 0) {
    list = (
      <Empty icon="calendar-clock" title="No tasks yet">
        Ask an agent to schedule a reminder, a script or a command — it shows up here with its next run.
      </Empty>
    );
  } else if (visible.length === 0) {
    list = (
      <Empty icon="calendar-clock" title="No tasks match" action="Clear search" onAction={() => go({ q: undefined })}>
        No task is named, described or commanded like “{route.q}”.
      </Empty>
    );
  } else {
    list = (
      <List className="sch-list" narrow="tiles">
        {visible.map(({ task, nextRunAt }) => (
          <TaskRow key={task.id} task={task} nextRunAt={nextRunAt} lastRun={lastRunOf(task.slug)} current={task.slug === route.slug} now={now} {...linkTarget(withScheduleFilters(route, { slug: task.slug, q: undefined }))} />
        ))}
      </List>
    );
  }

  let detail;

  if (detailStage === 'task' && selected) {
    detail = <TaskDetail key={selected.id} task={selected} nextRunAt={withNext.find(item => item.task.id === selected.id)?.nextRunAt ?? null} timezone={timezone} lastRun={lastRunOf(selected.slug) ?? null} now={now} />;
  } else if (detailStage === 'unknown') {
    detail = (
      <Card narrow="bare">
        <Empty icon="calendar-clock" title={`No task named “${route.slug}”`} action="All tasks" onAction={() => go({ slug: undefined })}>
          It was deleted or consumed by its one-off fire; its runs, if any, are in the log.
        </Empty>
      </Card>
    );
  } else if (detailStage === 'pick') {
    detail = (
      <Card narrow="bare">
        <Empty icon="calendar-clock" title="Pick a task">
          Its schedule, settings and runs with output show here.
        </Empty>
      </Card>
    );
  } else {
    detail = (
      <Card narrow="bare" label="Loading the task">
        <DetailSection>
          <span aria-hidden="true">
            <SkelStack widths={[32, 70, 48, 36, 54]} smFirst />
          </span>
        </DetailSection>
      </Card>
    );
  }

  let body;

  if (stage === 'failed') {
    body = (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load the schedule" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
          {stream.snapshot.error?.message}
        </Empty>
      </Card>
    );
  } else if (log) {
    body = (
      <>
        {bar}
        <RunLog task={route.task} tasks={tasks} now={now} onAll={() => go({ task: undefined })} />
      </>
    );
  } else {
    body = (
      <Split view={route.slug ? 'detail' : 'list'}>
        <SplitList>
          {bar}
          <Card narrow="bare">{list}</Card>
        </SplitList>
        <SplitDetail>{detail}</SplitDetail>
      </Split>
    );
  }

  return (
    <Shell current="schedule" title={shell.title} titleNarrow={shell.titleNarrow} back={shell.back} backNarrow={shell.backNarrow} detail={shell.detail}>
      <Screen>{body}</Screen>
    </Shell>
  );
}

function TaskRow({ task, nextRunAt, lastRun, current, now, href, onClick }: { task: TaskView; nextRunAt: Date | null; lastRun: JobRunView | null | undefined; current: boolean; now: Date; href: string; onClick: (event: MouseEvent<HTMLElement>) => void }) {
  const kind = kindWords(task.kind);
  const trigger = triggerWords(task, now);
  const last = lastRun ? lastRunWords(lastRun, now) : null;

  return (
    <Row
      href={href}
      onClick={onClick}
      current={current}
      lead={<Obj icon={kind.icon} size="md" />}
      title={task.name}
      meta={
        <>
          <Tag>{kind.label}</Tag> {trigger.human}
          {trigger.cron ? (
            <>
              {' · '}
              <Code>{trigger.cron}</Code>
            </>
          ) : null}
        </>
      }
      end={
        <>
          {last ? <Status state={last.state} label={last.label} /> : lastRun === null && task.kind === 'command' ? <Quiet>not run yet</Quiet> : null}
          {nextRunAt ? (
            <span className="row-time">
              {whenLabel(nextRunAt, now)}
              <small className="row-time-sub">next</small>
            </span>
          ) : (
            <span className="row-time">
              <Quiet>manual</Quiet>
              <small className="row-time-sub">no trigger</small>
            </span>
          )}
        </>
      }
    />
  );
}
