// Thread row (design: ThreadRow). Active (run · wait · act) — a dot on the
// avatar, the session state, "since 14:02 / running 2h 36m" and the context
// ring with its tooltip. Closed (done · err · off) — the summary, "start →
// end / duration". hit — the search match highlighted in the title and the
// summary. In a columned list (List endCols) the badge, the time and the
// ring line up across rows. pinned — the main thread above a list: a pin
// in place of the state badge, no dot on the avatar, no ring; the time is
// its last message's. The row is one link as a whole.

import type { MouseEvent, ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Badge } from '../Badge/Badge.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Row } from '../List/List.tsx';
import { Ctx } from '../Ring/Ctx.tsx';
import type { CtxInput } from '../Ring/Ring.logic.ts';
import { threadStateLabel } from '../ThreadHead/ThreadHead.logic.ts';
import { Code, Hit, Tag } from '../atoms/atoms.tsx';
import type { StateName } from '../atoms/state.ts';
import { highlightParts } from '../atoms/highlight.ts';
import { isActiveState, threadRowMeta } from './ThreadRow.logic.ts';
import type { ThreadRowMetaItem } from './ThreadRow.logic.ts';

export type ThreadRowProps = {
  agent: string;
  title: string;
  state: StateName;
  // Replaces the state's standard wording in the badge.
  label?: string;
  project?: string;
  headless?: boolean;
  kids?: number;
  // The last action: as text, or as a command chip (wins over text).
  last?: string;
  lastCode?: string;
  time: string;
  sub?: string;
  ctx?: CtxInput;
  // The summary of a closed thread.
  desc?: string;
  hit?: string;
  // No agent name in the details (on the agent's own page).
  noAgent?: boolean;
  current?: boolean;
  fresh?: boolean;
  // The main thread pinned above the list.
  pinned?: boolean;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

function Parts({ text, hit }: { text: string; hit?: string }) {
  return (
    <>
      {highlightParts(text, hit).map((part, i) => (part.hit ? <Hit key={i}>{part.text}</Hit> : part.text))}
    </>
  );
}

function MetaItem({ item }: { item: ThreadRowMetaItem }) {
  switch (item.kind) {
    case 'tag':
      return <Tag>{item.text}</Tag>;
    case 'code':
      return <Code>{item.text}</Code>;
    case 'kids':
      return (
        <>
          <Icon name="git-fork" size="xs" /> {item.text}
        </>
      );
    default:
      return <>{item.text}</>;
  }
}

export function ThreadRow({
  agent,
  title,
  state,
  label,
  project,
  headless,
  kids,
  last,
  lastCode,
  time,
  sub,
  ctx,
  desc,
  hit,
  noAgent,
  current,
  fresh,
  pinned,
  href,
  onClick,
}: ThreadRowProps) {
  const active = isActiveState(state);
  const meta = threadRowMeta({ agent, noAgent, headless, project, kids, last, lastCode });
  const metaNodes: ReactNode[] = meta.map((item, i) => (
    <span key={i}>
      {i > 0 ? ' · ' : null}
      <MetaItem item={item} />
    </span>
  ));

  return (
    <Row
      href={href}
      onClick={onClick}
      current={current}
      fresh={fresh}
      lead={<Avatar agent={agent} pip={active && !pinned ? state : undefined} />}
      title={<Parts text={title} hit={hit} />}
      meta={metaNodes.length ? metaNodes : undefined}
      desc={desc ? <Parts text={desc} hit={hit} /> : undefined}
      end={
        <>
          {pinned ? (
            <span className="row-pin">
              <Icon name="pin" size="xs" />
              pinned
            </span>
          ) : (
            <Badge state={state} label={threadStateLabel(state, label)} />
          )}
          <span className="row-time">
            {time}
            {sub ? <small className="row-time-sub">{sub}</small> : null}
          </span>
          {ctx && !pinned ? <Ctx {...ctx} /> : null}
        </>
      }
    />
  );
}
