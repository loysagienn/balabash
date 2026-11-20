// One run as an expandable row (design: Xp in the Schedule's runs and
// log): the state icon, the words of the run, and — opened — its output:
// the code, the console tail, the return value or error. The output is read when the row
// opens (Xp mounts its body only then) — one run whole from the journal
// (useScheduleRun); a run still going has no output yet and says so — it is
// read again while it goes, and a failed re-read is told over the output
// read before (the words "still running" may be old by then).

import type { ScheduleRunDetailView, ScheduleRunView } from '../../../api/contract.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Skel, SkelStack } from '../../ui/Skel/Skel.tsx';
import { Terminal, TermErr, TermLine, Trunc } from '../../ui/Terminal/Terminal.tsx';
import { Xp } from '../../ui/Xp/Xp.tsx';
import { ErrorLine } from '../../ui/atoms/atoms.tsx';
import type { RunRowWords } from './ScheduleScreen.logic.ts';
import { useScheduleRun } from './queries.ts';

export function RunRow({ run, words }: { run: ScheduleRunView; words: RunRowWords }) {
  return (
    <Xp state={words.state} icon={words.icon} tool={words.tool} arg={words.arg} end={words.end} endState={words.endState}>
      <RunOutput id={run.id} />
    </Xp>
  );
}

const lines = (text: string) => text.replace(/\n$/, '').split('\n');

export function RunOutputBody({ run }: { run: ScheduleRunDetailView }) {
  return (
    <>
      <Terminal>
        <TermLine dim>{run.code}</TermLine>
        {run.consoleTruncated ? <Trunc>Console truncated — last 16 KiB shown</Trunc> : null}
        {run.console ? lines(run.console).map((line, i) => <TermLine key={i}>{line}</TermLine>) : null}
        {run.error ? <TermLine><TermErr>{run.error}</TermErr></TermLine> : null}
        {run.status === 'ok' ? <TermLine>Returned {JSON.stringify(run.value)}</TermLine> : null}
        {run.status === 'running' ? <TermLine dim>Still running</TermLine> : null}
      </Terminal>
    </>
  );
}

function RunOutput({ id }: { id: string }) {
  const query = useScheduleRun(id);

  if (query.data) {
    return (
      <>
        {query.error ? (
          <Note state="err" icon="cloud-off" role="status" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
            Couldn’t refresh the output — {query.error.message}. Showing the run as read before.
          </Note>
        ) : null}
        <RunOutputBody run={query.data} />
      </>
    );
  }

  if (query.error) {
    return (
      <span className="sch-run-fail">
        <ErrorLine>Couldn’t load the output — {query.error.message}</ErrorLine>
        <Btn label="Retry" icon="refresh-cw" size="sm" busy={query.isFetching} onClick={() => void query.refetch()} />
      </span>
    );
  }

  return (
    <span aria-busy="true">
      <Skel shape="line-sm" w={48} />
      <SkelStack widths={[70, 55]} />
    </span>
  );
}
