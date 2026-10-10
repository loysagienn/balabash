// The selected task (design: the right panel of the Schedule): its name
// and kind, "Run now" and the "⋯" menu with the delete; a banner when the
// last run went wrong; the facts — description, schedule spelled out with
// its expression, the next run in the schedule's time zone, the note of a
// reminder, the command, folder, timeout and "on success" of a command
// job, who created it; then its runs with output (a command job's journal,
// newest first, the newest few — the full log is a link away) or a line on
// what the kind leaves behind instead.

import { useState } from 'react';
import type { JobRunView, TaskView } from '../../../api/contract.ts';
import { Link } from '../../lib/router/Link.tsx';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { runTask } from '../../store/schedule/actions.ts';
import { selectTaskCall } from '../../store/schedule/selectors.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { DetailSection } from '../../ui/Split/Split.tsx';
import { ActGroup } from '../../ui/Xp/Xp.tsx';
import { Code, Quiet } from '../../ui/atoms/atoms.tsx';
import { DeleteTaskDialog } from './DeleteTaskDialog.tsx';
import { RunRow } from './RunRow.tsx';
import { createdWords, kindWords, lastRunNote, noJournalWords, taskRunWords, timeoutWords, triggerWords, whenLabel, whenLabelIn } from './ScheduleScreen.logic.ts';
import { useJobRuns } from './queries.ts';

// The runs shown under the task; the log has the rest.
export const TASK_RUNS = 8;

function TaskMenu({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <>
      <MenuAnchor
        open={open}
        onClose={() => setOpen(false)}
        menu={
          <Menu label="Task actions">
            <MenuItem
              icon="trash-2"
              label="Delete task…"
              variant="danger"
              onClick={() => {
                setOpen(false);
                setConfirm(true);
              }}
            />
          </Menu>
        }
      >
        <IconBtn icon="ellipsis" label="More: delete" size="sm" expanded={open} onClick={() => setOpen(!open)} />
      </MenuAnchor>
      {confirm ? <DeleteTaskDialog task={task} onClose={() => setConfirm(false)} /> : null}
    </>
  );
}

// The runs read before stay in sight when a re-read fails — the empty
// list included: "No runs yet" after a failed re-read is an old answer,
// and the note says so.
function TaskRuns({ task, now }: { task: TaskView; now: Date }) {
  const query = useJobRuns(task.slug, TASK_RUNS);
  const runs: JobRunView[] = query.data?.pages[0]?.runs ?? [];

  if (query.data) {
    const stale = query.error ? (
      <Note state="err" icon="cloud-off" role="status" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
        Couldn’t refresh the runs — {query.error.message}. Showing the runs read before.
      </Note>
    ) : null;

    if (runs.length === 0) {
      return (
        <>
          {stale}
          <Empty icon="square-terminal" title="No runs yet">
            Every run of the command lands here with its exit code and output — the scheduled ones and the manual ones alike.
          </Empty>
        </>
      );
    }

    return (
      <>
        {stale}
        <ActGroup>
          {runs.map(run => (
            <RunRow key={run.id} run={run} words={taskRunWords(run, now)} />
          ))}
        </ActGroup>
      </>
    );
  }

  if (query.error) {
    return (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the runs" action="Retry" actionIcon="refresh-cw" onAction={() => void query.refetch()}>
        {query.error.message}
      </Empty>
    );
  }

  return (
    <span aria-busy="true">
      <SkelRow widths={[40, 62]} pill={false} />
      <SkelRow widths={[44, 58]} pill={false} />
    </span>
  );
}

export function TaskDetail({ task, nextRunAt, timezone, lastRun, now }: { task: TaskView; nextRunAt: Date | null; timezone: string | null; lastRun: JobRunView | null; now: Date }) {
  const dispatch = useAppDispatch();
  const call = useAppSelector(s => selectTaskCall(s, task.slug));
  const kind = kindWords(task.kind);
  const trigger = triggerWords(task, now);
  const note = lastRun ? lastRunNote(lastRun, now) : null;
  const noJournal = noJournalWords(task.kind);
  const items = [
    ...(task.description ? [{ key: 'description', value: task.description }] : []),
    {
      key: 'schedule',
      value: (
        <>
          {trigger.human}
          {trigger.cron ? (
            <>
              {' · '}
              <Code>{trigger.cron}</Code>
            </>
          ) : null}
        </>
      ),
    },
    ...(nextRunAt
      ? [
          {
            key: 'next',
            value: (
              // The moment in the schedule's zone, named — the cron words above
              // are that zone's; without the zone yet, the browser's clock unnamed.
              <>
                {timezone ? whenLabelIn(nextRunAt, now, timezone) : whenLabel(nextRunAt, now)}
                {timezone ? <Quiet> · {timezone}</Quiet> : null}
              </>
            ),
          },
        ]
      : []),
    ...(task.kind === 'note' && task.note ? [{ key: 'note', value: task.note }] : []),
    ...(task.kind === 'command'
      ? [
          { key: 'command', value: <Code wrap>{task.command ?? ''}</Code> },
          { key: 'workspace folder', value: task.cwd ? <Code>{task.cwd}</Code> : <Quiet>the file area root</Quiet> },
          { key: 'timeout', value: timeoutWords(task.timeoutMs) },
          { key: 'on success', value: task.reportOnSuccess ? 'notify the main thread' : 'don’t notify' },
        ]
      : []),
    { key: 'created by', value: createdWords(task, now) },
  ];

  return (
    <Card narrow="bare" label={task.name}>
      <CardHead title={task.name} tag={kind.label}>
        <Btn label="Run now" icon="play" size="sm" busy={call?.kind === 'run'} disabled={call?.kind === 'delete'} onClick={() => dispatch(runTask(task.slug, task.id))} />
        <TaskMenu task={task} />
      </CardHead>
      <DetailSection>
        {note ? (
          <Note state="err" icon="circle-x">
            {note}
          </Note>
        ) : null}
        <KeyValue items={items} />
      </DetailSection>
      <DetailSection
        title="Runs"
        end={
          task.kind === 'command' ? (
            <Link className="link" route={{ key: 'schedule', tab: 'log', task: task.slug }}>
              Full log
              <Icon name="chevron-right" />
            </Link>
          ) : undefined
        }
      >
        {noJournal ? <Quiet>{noJournal}</Quiet> : <TaskRuns task={task} now={now} />}
      </DetailSection>
    </Card>
  );
}
