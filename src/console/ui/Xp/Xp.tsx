// Agent action on one line (design: Xp): the state icon, the tool and its
// argument (tool / arg, mono) or a summary (text / textArg: "Read 3 files
// in src/api"); on the right the time and the changes (+38 −6). Details
// (children) open on press and mount only then — a feed holds hundreds of
// rows whose details (terminal output, diffs) nobody opened; defaultOpen —
// expanded at first. depth=1 — a nested call under a batch summary.
// Consecutive actions go in an ActGroup (design: .actgroup).

import { Children, useState } from 'react';
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
  children,
}: XpProps) {
  const [open, setOpen] = useState(defaultOpen);
  const run = state === 'run';
  const hasBody = children !== undefined && children !== null && children !== false;

  return (
    <div className="xp" data-depth={depth}>
      <button
        type="button"
        className="xp-h"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name="chevron-right" className="xp-chev" />
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
      </button>
      {hasBody && open ? <div className="xp-b">{children}</div> : null}
    </div>
  );
}

// How a group folds (design: .actgroup[data-fold], .actfold): `at` — the
// index of the last top-level action among the children (its depth-1 rows
// follow it), `earlier` — how many top-level actions come before it,
// `failed` — how many of those failed. Null — the group does not fold (one
// action).
export type ActFold = { at: number; earlier: number; failed: number } | null;

// A group of consecutive actions. With `fold` it folds to its last action
// — closed by default; the counter at the left ("+4", red "+4 · 1 failed"
// when a folded one failed) shows the earlier actions above it and folds
// them back; an open group stays open as actions arrive (the state lives
// here, the parent keeps the element). Each row still opens its own details.
export function ActGroup({ children, fold = null }: { children: ReactNode; fold?: ActFold }) {
  const [open, setOpen] = useState(false);

  if (!fold) {
    return <div className="actgroup">{children}</div>;
  }

  const rows = Children.toArray(children);
  const failed = fold.failed > 0;
  const label = open
    ? 'Fold earlier actions'
    : `Show ${fold.earlier} earlier ${fold.earlier === 1 ? 'action' : 'actions'}${failed ? `, ${fold.failed} failed` : ''}`;

  return (
    <div className="actgroup" data-fold={open ? 'open' : 'closed'}>
      {rows.slice(0, fold.at)}
      <button
        type="button"
        className="actfold"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-state={!open && failed ? 'err' : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span className="actfold-n">{open ? <Icon name="chevrons-down-up" /> : `+${fold.earlier}${failed ? ` · ${fold.failed} failed` : ''}`}</span>
      </button>
      {rows.slice(fold.at)}
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

  rows.forEach((row, i) => {
    if (row.depth === undefined) {
      at = i;
      top += 1;
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

  return { at, earlier: top - 1, failed };
}
