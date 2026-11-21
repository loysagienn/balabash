// One action of the feed as an Xp row: the words of the projection, the
// time on the right (a live timer while it runs — `now` ticks every second
// then), and the details that mount when the row opens: a terminal with
// the command and its output, a diff (with the tool's refusal above it
// when the change failed), a sub-agent's report as Markdown, whole, the code
// of a program as a highlighted block with what it wrote to `console` and
// what it ended with, the input and the result of any other tool — each but
// the report cut to a readable size with an honest notice. The frames of a native sub-agent render under the row.
// `still` — the folded row of an action group: no chevron, no details (Xp still).

import { Md } from '../../ui/Md/Md.tsx';
import { TermLine, Terminal, Trunc } from '../../ui/Terminal/Terminal.tsx';
import { Xp } from '../../ui/Xp/Xp.tsx';
import { actionDuration } from './actions.ts';
import type { ActionDetail } from './actions.ts';
import { actionTimer, cutText, fence } from './details.ts';
import type { Cut } from './details.ts';
import type { ActionItem } from './project.ts';
import { FeedItems } from './ThreadFeed.tsx';

function Notice({ cut }: { cut: Cut }) {
  return cut.cut ? (
    <Trunc>
      Showing the first {cut.text.length.toLocaleString('en-US')} of {cut.total.toLocaleString('en-US')} characters
    </Trunc>
  ) : null;
}

// What a call ended with: its value, or its error.
function Result({ output, error }: { output: string | null; error: boolean }) {
  if (output === null) {
    return null;
  }

  const cut = cutText(output);

  return (
    <>
      <Terminal className={error ? 'tf-term-err' : undefined}>
        <TermLine dim>{error ? 'error' : 'result'}</TermLine>
        {cut.text || '(empty)'}
      </Terminal>
      <Notice cut={cut} />
    </>
  );
}

function Details({ detail, error }: { detail: ActionDetail; error: boolean }) {
  switch (detail.kind) {
    case 'terminal': {
      const output = cutText(detail.output);

      return (
        <>
          <Terminal className={error ? 'tf-term-err' : undefined}>
            <TermLine dim>$ {detail.command}</TermLine>
            {output.text}
          </Terminal>
          <Notice cut={output} />
        </>
      );
    }
    case 'diff': {
      const diff = cutText(detail.diff);
      const failure = detail.error === undefined ? null : cutText(detail.error);

      return (
        <>
          {failure ? (
            <>
              <Terminal className="tf-term-err">
                <TermLine dim>error</TermLine>
                {failure.text}
              </Terminal>
              <Notice cut={failure} />
            </>
          ) : null}
          <Md quiet source={fence('diff', diff.text)} />
          <Notice cut={diff} />
        </>
      );
    }
    case 'report':
      // Asked for whole: the row is the folded form, opening it is "show all".
      return <Md quiet source={detail.text} />;
    case 'program': {
      const code = cutText(detail.code);
      const log = detail.console ? cutText(detail.console) : null;

      return (
        <>
          <Md quiet source={fence('js', code.text)} />
          <Notice cut={code} />
          {log ? (
            <>
              <Terminal>
                <TermLine dim>console</TermLine>
                {log.text}
              </Terminal>
              {detail.consoleTruncated ? <Trunc>Only the end of the console output was kept</Trunc> : null}
              <Notice cut={log} />
            </>
          ) : null}
          <Result output={detail.output} error={error} />
        </>
      );
    }
    case 'io': {
      const input = cutText(detail.input);

      return (
        <>
          {input.text ? (
            <>
              <Terminal>
                <TermLine dim>input</TermLine>
                {input.text}
              </Terminal>
              <Notice cut={input} />
            </>
          ) : null}
          <Result output={detail.output} error={error} />
        </>
      );
    }
  }
}

export function FeedAction({ item, now, still }: { item: ActionItem; now: Date; still?: boolean }) {
  const running = item.endedAt === null;
  const ms = (item.endedAt ?? now).getTime() - item.at.getTime();
  const duration = item.untimed ? null : running ? actionTimer(ms) : actionDuration(ms);
  const end = [item.endNote, duration].filter((part): part is string => part !== null).join(' · ');
  const endState = running ? 'run' : item.state === 'err' ? 'err' : item.state === 'off' ? 'off' : undefined;
  const hasDetails = item.detail !== null || item.nested.length > 0;

  return (
    <Xp
      state={item.state}
      icon={item.label.icon}
      tool={item.label.tool}
      arg={item.label.arg}
      text={item.label.text}
      textArg={item.label.textArg}
      end={end || undefined}
      endState={endState}
      add={item.add ? `+${item.add}` : undefined}
      del={item.del ? `−${item.del}` : undefined}
      depth={item.depth}
      still={still}
    >
      {hasDetails ? (
        <>
          {item.detail ? <Details detail={item.detail} error={item.state === 'err'} /> : null}
          {item.nested.length > 0 ? (
            <div className="tf-nested">
              <FeedItems items={item.nested} now={now} />
            </div>
          ) : null}
        </>
      ) : undefined}
    </Xp>
  );
}
