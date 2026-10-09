// Labeled field (design: Field): label (+ "optional"), the control
// (children), a hint or an error below it. The hint and the error carry
// ids named by the field (Field.logic.ts) and the control reads them from
// FieldContext — an Input inside a Field describes itself by them and
// says whether it is required; the error is also announced as it appears
// (role="alert"). required — the value must be given for the form to go
// (aria-required on the control; the look stays the design's: "optional"
// marks the other side).

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { Code } from '../atoms/atoms.tsx';
import { fieldIds } from './Field.logic.ts';
import './Field.css';

export type FieldControl = {
  describedBy?: string;
  // The id of the error shown (aria-errormessage of an invalid control).
  errId?: string;
  required?: boolean;
};

export const FieldContext = createContext<FieldControl>({});

export function useFieldControl(): FieldControl {
  return useContext(FieldContext);
}

export type FieldProps = {
  label: string;
  fid: string;
  opt?: string;
  hint?: ReactNode;
  hintCode?: string;
  err?: ReactNode;
  required?: boolean;
  children: ReactNode;
};

export function Field({ label, fid, opt, hint, hintCode, err, required, children }: FieldProps) {
  const ids = fieldIds(fid, { hint: Boolean(hint || hintCode), err: Boolean(err) });
  const control: FieldControl = { ...(ids.describedBy ? { describedBy: ids.describedBy } : {}), ...(ids.errId ? { errId: ids.errId } : {}), ...(required ? { required } : {}) };

  return (
    <div className="fld">
      <label className="fld-l" htmlFor={fid}>
        {label}
        {opt ? <span className="fld-opt">{opt}</span> : null}
      </label>
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {hint || hintCode ? (
        <p className="fld-h" id={ids.hintId}>
          {hint}
          {hintCode ? <Code>{hintCode}</Code> : null}
        </p>
      ) : null}
      {err ? (
        <p className="fld-e" id={ids.errId} role="alert">
          <Icon name="circle-alert" />
          {err}
        </p>
      ) : null}
    </div>
  );
}

// Moves the focus to the first invalid control of a form (aria-invalid —
// the Input's mark) after a submit that failed its checks, so the keyboard
// and the screen reader land on what to fix. True when one was found.
export function focusFirstInvalid(form: ParentNode | null): boolean {
  const control = form?.querySelector('[aria-invalid="true"]');

  if (control instanceof HTMLElement) {
    control.focus();

    return true;
  }

  return false;
}
