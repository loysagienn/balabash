// One action of the feed as an Xp row: the words of the projection, the
// time on the right (a live timer while it runs — `now` ticks every second
// then), and the details that mount when the row opens: a terminal with
// the command and its output, a diff, the thought as Markdown, the input
// and the result of any other tool — each cut to a readable size with an
// honest notice. The frames of a native sub-agent render under the row.

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

      return (
        <>
          <Md quiet source={fence('diff', diff.text)} />
          <Notice cut={diff} />
        </>
      );
    }
    case 'md': {
      const text = cutText(detail.text);

      return (
        <>
          <Md quiet source={text.text} />
          <Notice cut={text} />
        </>
      );
    }
    case 'io': {
      const input = cutText(detail.input);
      const output = detail.output === null ? null : cutText(detail.output);

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
          {output ? (
            <>
              <Terminal className={error ? 'tf-term-err' : undefined}>
                <TermLine dim>{error ? 'error' : 'result'}</TermLine>
                {output.text || '(empty)'}
              </Terminal>
              <Notice cut={output} />
            </>
          ) : null}
        </>
      );
    }
  }
}

export function FeedAction({ item, now }: { item: ActionItem; now: Date }) {
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
