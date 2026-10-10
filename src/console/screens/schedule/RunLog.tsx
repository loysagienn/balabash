// The run log (design: the "Run log" tab of the Schedule): every run of
// every command job in a row, newest first under day dividers, each named
// by its task; earlier pages on demand. Narrowed to one task from its
// details ("Full log") — a banner names the task and leads back to all.
// A run still going keeps the list polling (queries.ts).

import type { JobRunView, TaskView } from '../../../api/contract.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { ListGroup } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { ActGroup } from '../../ui/Xp/Xp.tsx';
import { RunRow } from './RunRow.tsx';
import { groupRunsByDay, logRunWords } from './ScheduleScreen.logic.ts';
import { useJobRuns } from './queries.ts';

export const LOG_PAGE = 50;

export function RunLog({ task, tasks, now, onAll }: { task: string | undefined; tasks: TaskView[]; now: Date; onAll: () => void }) {
  const query = useJobRuns(task, LOG_PAGE);
  const runs: JobRunView[] = query.data?.pages.flatMap(page => page.runs) ?? [];
  const named = task ? (tasks.find(item => item.slug === task)?.name ?? task) : null;
  const nameOf = (slug: string) => tasks.find(item => item.slug === slug)?.name ?? slug;

  let body;

  if (query.data) {
    if (runs.length === 0) {
      body = (
        <Empty icon="square-terminal" title={task ? `No runs of “${named}” yet` : 'No runs yet'}>
          Every run of a command task lands here with its exit code and output.
        </Empty>
      );
    } else {
      body = (
        <>
          {groupRunsByDay(runs, now).map(day => (
            <div key={day.key} className="sch-day">
              <ListGroup>{day.label}</ListGroup>
              <ActGroup>
                {day.runs.map(run => (
                  <RunRow key={run.id} run={run} words={logRunWords(run, nameOf(run.slug), now)} />
                ))}
              </ActGroup>
            </div>
          ))}
          {query.hasNextPage ? (
            <div className="sch-more">
              <Btn label="Earlier runs" icon="history" size="sm" busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
            </div>
          ) : null}
        </>
      );
    }
  } else if (query.error) {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the run log" action="Retry" actionIcon="refresh-cw" onAction={() => void query.refetch()}>
        {query.error.message}
      </Empty>
    );
  } else {
    body = (
      <span aria-busy="true">
        <SkelRow widths={[40, 62]} pill={false} />
        <SkelRow widths={[44, 58]} pill={false} />
        <SkelRow widths={[36, 66]} pill={false} />
      </span>
    );
  }

  return (
    <>
      {named ? (
        <Note icon="square-terminal" role="status" action="All runs" onAction={onAll}>
          Runs of “{named}” only.
        </Note>
      ) : null}
      {query.data && query.error ? (
        <Note state="err" icon="cloud-off" role="status" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
          Couldn’t refresh the run log — {query.error.message}. Showing the runs read before.
        </Note>
      ) : null}
      <Card narrow="bare" label="Run log">
        {body}
      </Card>
    </>
  );
}
