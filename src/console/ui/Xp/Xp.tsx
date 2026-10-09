// Agent action on one line (design: Xp): the state icon, the tool and its
// argument (tool / arg, mono) or a summary (text / textArg: "Read 3 files
// in src/api"); on the right the time and the changes (+38 −6). Details
// (children) open on press; defaultOpen — expanded at first. depth=1 — a
// nested call under a batch summary. Consecutive actions go in an
// ActGroup (design: .actgroup).

import { useState } from 'react';
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
      {hasBody ? <div className="xp-b">{children}</div> : null}
    </div>
  );
}

export function ActGroup({ children }: { children: ReactNode }) {
  return <div className="actgroup">{children}</div>;
}
