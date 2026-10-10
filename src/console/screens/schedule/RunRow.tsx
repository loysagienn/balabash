// One run as an expandable row (design: Xp in the Schedule's runs and
// log): the state icon, the words of the run, and — opened — its output:
// the command it ran, the stdout tail, the stderr tail in red, an honest
// notice where a tail lost its beginning. The output is read when the row
// opens (Xp mounts its body only then) — one run whole from the journal
// (useJobRun); a run still going has no output yet and says so.

import type { JobRunDetailView, JobRunView } from '../../../api/contract.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Skel, SkelStack } from '../../ui/Skel/Skel.tsx';
import { Terminal, TermErr, TermLine, Trunc } from '../../ui/Terminal/Terminal.tsx';
import { Xp } from '../../ui/Xp/Xp.tsx';
import { ErrorLine } from '../../ui/atoms/atoms.tsx';
import type { RunRowWords } from './ScheduleScreen.logic.ts';
import { useJobRun } from './queries.ts';

export function RunRow({ run, words }: { run: JobRunView; words: RunRowWords }) {
  return (
    <Xp state={words.state} icon={words.icon} tool={words.tool} arg={words.arg} end={words.end} endState={words.endState}>
      <RunOutput id={run.id} />
    </Xp>
  );
}

const lines = (text: string) => text.replace(/\n$/, '').split('\n');

export function RunOutputBody({ run }: { run: JobRunDetailView }) {
  const stdout = run.stdoutTail ? lines(run.stdoutTail) : [];
  const stderr = run.stderrTail ? lines(run.stderrTail) : [];

  return (
    <>
      {run.stdoutTruncated || run.stderrTruncated ? <Trunc>{run.stdoutTruncated && run.stderrTruncated ? 'both streams were cut' : run.stdoutTruncated ? 'stdout was cut' : 'stderr was cut'} — the last 16 KiB are kept</Trunc> : null}
      <Terminal>
        <TermLine dim>$ {run.command}</TermLine>
        {stdout.map((line, i) => (
          <TermLine key={`o${i}`}>{line}</TermLine>
        ))}
        {stderr.map((line, i) => (
          <TermLine key={`e${i}`}>
            <TermErr>{line}</TermErr>
          </TermLine>
        ))}
        {stdout.length === 0 && stderr.length === 0 ? <TermLine dim>{run.status === 'running' ? 'still running — the output arrives when the run ends' : '(no output)'}</TermLine> : null}
      </Terminal>
    </>
  );
}

function RunOutput({ id }: { id: string }) {
  const query = useJobRun(id);

  if (query.data) {
    return <RunOutputBody run={query.data} />;
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
