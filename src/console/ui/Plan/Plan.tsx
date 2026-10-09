// Agent plan (design: Plan, PlanItem): "Plan · N of M" and the items —
// done is struck through with a check, run spins, no state is a dashed
// circle.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import './Plan.css';

export function Plan({ done, total, children }: { done: number; total: number; children: ReactNode }) {
  return (
    <div className="plan">
      <div className="plan-h">
        <Icon name="list-todo" />
        Plan
        <span className="plan-h-end">
          {done} of {total}
        </span>
      </div>
      {children}
    </div>
  );
}

export type PlanItemState = 'run' | 'done';

export function PlanItem({ state, children }: { state?: PlanItemState; children: ReactNode }) {
  return (
    <div className="plan-i" data-state={state}>
      <Icon
        name={state === 'done' ? 'circle-check' : state === 'run' ? 'loader-circle' : 'circle-dashed'}
        spin={state === 'run'}
      />
      <span>{children}</span>
    </div>
  );
}
