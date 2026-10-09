// Labeled field (design: Field): label (+ "optional"), the control
// (children), a hint or an error below it.

import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Field.css';

export type FieldProps = {
  label: string;
  fid: string;
  opt?: string;
  hint?: ReactNode;
  hintCode?: string;
  err?: ReactNode;
  children: ReactNode;
};

export function Field({ label, fid, opt, hint, hintCode, err, children }: FieldProps) {
  return (
    <div className="fld">
      <label className="fld-l" htmlFor={fid}>
        {label}
        {opt ? <span className="fld-opt">{opt}</span> : null}
      </label>
      {children}
      {hint || hintCode ? (
        <p className="fld-h">
          {hint}
          {hintCode ? <Code>{hintCode}</Code> : null}
        </p>
      ) : null}
      {err ? (
        <p className="fld-e" role="alert">
          <Icon name="circle-alert" />
          {err}
        </p>
      ) : null}
    </div>
  );
}
