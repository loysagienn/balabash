// Agent action on one line (design: Xp): the state icon, the tool and its
// argument (tool / arg, mono) or a summary (text / textArg: "Read 3 files
// in src/api"); on the right the time and the changes (+38 −6). Details
// (children) open on press and mount only then — a feed holds hundreds of
// rows whose details (terminal output, diffs) nobody opened; defaultOpen —
// expanded at first. depth=1 — a nested call under a batch summary. still —
// the row does not open: no chevron, the head is not a button and the
// details are not rendered (the folded row of an action group).
// Consecutive actions go in an ActGroup (design: .actgroup).

import { Children, cloneElement, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Xp.css';

export type XpState = 'run' | 'done' | 'err' | 'off';

export type XpProps = {
  state: XpState;
  icon?: IconName;
  tool?: string;
  arg?: string;
  text?: string;
  textArg?: string;
  end?: string;
  endState?: 'run' | 'err' | 'off';
  add?: string;
  del?: string;
  depth?: 1;
  defaultOpen?: boolean;
  still?: boolean;
  children?: ReactNode;
};

export function Xp({
  state,
  icon = 'check',
  tool,
  arg,
  text,
  textArg,
  end,
  endState,
  add,
  del,
  depth,
  defaultOpen = false,
  still = false,
  children,
}: XpProps) {
  const [open, setOpen] = useState(defaultOpen);
  const run = state === 'run';
  const hasBody = children !== undefined && children !== null && children !== false;
  const head = (
    <>
      {still ? null : <Icon name="chevron-right" className="xp-chev" />}
      <span className="xp-s" data-state={state}>
        <Icon name={run ? 'loader-circle' : icon} spin={run} />
      </span>
      <span className="xp-t">
        {tool ? (
          <>
            <b className="xp-name">{tool}</b>
            {arg ? <span className="xp-arg">{arg}</span> : null}
          </>
        ) : null}
        {text ? (
          <>
            {text}
            {textArg ? (
              <>
                {' '}
                <span className="xp-arg">{textArg}</span>
              </>
            ) : null}
          </>
        ) : null}
      </span>
      <span className="xp-end" data-state={endState}>
        {add ? <span className="xp-add">{add}</span> : null}
        {del ? <span className="xp-del">{del}</span> : null}
        {end}
      </span>
    </>
  );

  if (still) {
    return (
      <div className="xp" data-depth={depth} data-still="">
        <div className="xp-h">{head}</div>
      </div>
    );
  }

  return (
    <div className="xp" data-depth={depth}>
      <button
        type="button"
        className="xp-h"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen(value => !value)}
      >
        {head}
      </button>
      {hasBody && open ? <div className="xp-b">{children}</div> : null}
    </div>
  );
}

// How a group folds (design: .actgroup[data-fold], .actfold): `at` — the
// index of the last top-level action among the children (its depth-1 rows
// follow it), `earlier` — how many top-level actions come before it,
// `failed` — how many of those failed, `failedAll` — how many top-level
// actions of the whole group failed. Null — the group does not fold (one
// action).
export type ActFold = { at: number; earlier: number; failed: number; failedAll: number } | null;

// A group of consecutive actions. With `fold` it folds to one row — closed
// by default: the counter at its start ("+4", red "+4 · 1 failed" when a
// folded one failed) and the last action, still (no chevron, it does not
// open); the counter's button stretches over the row, so the whole row
// unfolds the group. Open, the counter is a thin row on top, in the same
// place ("⌃ 5 actions", "· 1 failed" when any action of the group failed),
// which folds it back; every action is full width and opens its own
// details. An open group stays open as actions arrive (the state lives
// here, the parent keeps the element). The still row is the child at
// `fold.at` cloned with `still` — Xp and FeedAction take it.
export function ActGroup({ children, fold = null }: { children: ReactNode; fold?: ActFold }) {
  const [open, setOpen] = useState(false);

  if (!fold) {
    return <div className="actgroup">{children}</div>;
  }

  const rows = Children.toArray(children);
  const total = fold.earlier + 1;
  const actions = (n: number) => `${n} ${n === 1 ? 'action' : 'actions'}`;
  const failedNote = (n: number) => (n > 0 ? ` · ${n} failed` : '');
  const label = open ? `Fold ${actions(total)}` : `Show all ${actions(total)}${fold.failed > 0 ? `, ${fold.failed} failed` : ''}`;
  const failed = open ? fold.failedAll : fold.failed;
  const shown = open ? rows : rows.map((row, i) => (i === fold.at && isValidElement<{ still?: boolean }>(row) ? cloneElement(row, { still: true }) : row));

  return (
    <div className="actgroup" data-fold={open ? 'open' : 'closed'}>
      <button
        type="button"
        className="actfold"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-state={failed > 0 ? 'err' : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span className="actfold-n">
          {open ? (
            <>
              <Icon name="chevrons-down-up" />
              {actions(total)}
              {failedNote(failed)}
            </>
          ) : (
            `+${fold.earlier}${failedNote(failed)}`
          )}
        </span>
      </button>
      {shown}
    </div>
  );
}

// The fold of a group from its rows: the last top-level row (depth
// undefined) is the one that stays; the group folds when there are two or
// more top-level rows.
export function actFold(rows: readonly { depth?: 1; state: XpState }[]): ActFold {
  let at = -1;
  let top = 0;
  let failed = 0;
  let failedAll = 0;

  rows.forEach((row, i) => {
    if (row.depth === undefined) {
      at = i;
      top += 1;

      if (row.state === 'err') {
        failedAll += 1;
      }
    }
  });

  if (top < 2) {
    return null;
  }

  for (let i = 0; i < at; i += 1) {
    if (rows[i].depth === undefined && rows[i].state === 'err') {
      failed += 1;
    }
  }

  return { at, earlier: top - 1, failed, failedAll };
}
