// Subagent or background task inside a turn (design: Subtask): what it is
// doing (children), its state, usage (meta: tokens, calls, time) and the
// last call (lastCode, as a command).

import type { ReactNode } from 'react';
import { Badge } from '../Badge/Badge.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Code } from '../atoms/atoms.tsx';
import type { StateName } from '../atoms/state.ts';
import './Subtask.css';

const LABEL: Record<StateName, string> = {
  run: 'running',
  wait: 'waiting',
  act: 'action needed',
  done: 'done',
  err: 'error',
  off: 'cancelled',
};

export type SubtaskProps = {
  kind: string;
  state: StateName;
  label?: string;
  meta?: string[];
  lastCode?: string;
  children: ReactNode;
};

export function Subtask({ kind, state, label, meta, lastCode, children }: SubtaskProps) {
  return (
    <div className="subtask">
      <Obj icon="bot" size="md" className="subtask-ic" />
      <span className="subtask-t">
        <small className="subtask-k">{kind}</small>
        {children}
      </span>
      <Badge state={state} label={label || LABEL[state]} className="subtask-st" />
      {(meta && meta.length > 0) || lastCode ? (
        <span className="subtask-m">
          {meta?.map((item, i) => (
            <span key={i}>{item}</span>
          ))}
          {lastCode ? (
            <span>
              last: <Code>{lastCode}</Code>
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
