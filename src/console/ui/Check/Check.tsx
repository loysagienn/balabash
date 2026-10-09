// Checkbox, radio or switch (design: Check). The label sits on the right
// and the whole row is the hit area. Controlled: checked + onChange.

import type { ReactNode } from 'react';
import './Check.css';

export type CheckProps = {
  kind?: 'checkbox' | 'radio' | 'switch';
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  value?: string;
  id?: string;
};

export function Check({ kind = 'checkbox', label, checked, onChange, disabled, name, value, id }: CheckProps) {
  return (
    <label className="chk">
      <input
        id={id}
        className={kind === 'switch' ? 'tgl' : 'chk-box'}
        type={kind === 'radio' ? 'radio' : 'checkbox'}
        role={kind === 'switch' ? 'switch' : undefined}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
