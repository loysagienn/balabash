// Input field (design: Input): input or textarea inside the .inp frame.
// lead — an icon on the left, pre — a prefix ("/p/"), end — the right edge
// (a key, an icon button). mono — technical values (codes, slugs, paths).

import type { ChangeEvent, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Input.css';

type Shared = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  lead?: IconName;
  pre?: string;
  mono?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  end?: ReactNode;
  name?: string;
};

export type InputProps = Shared &
  (
    | ({ as?: 'input' } & Pick<InputHTMLAttributes<HTMLInputElement>, 'type' | 'autoComplete' | 'spellCheck' | 'inputMode' | 'maxLength' | 'autoCapitalize'>)
    | ({ as: 'textarea' } & Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'spellCheck' | 'maxLength'>)
  );

export function Input(props: InputProps) {
  const { id, value, onChange, placeholder, lead, pre, mono, invalid, disabled, readOnly, autoFocus, ariaLabel, end, name } = props;
  const common = {
    id,
    name,
    value,
    placeholder,
    disabled,
    readOnly,
    autoFocus,
    'aria-invalid': invalid ? ('true' as const) : undefined,
    'aria-label': ariaLabel,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };

  return (
    <div className="inp" data-variant={mono ? 'mono' : undefined}>
      {lead ? <Icon name={lead} /> : null}
      {pre ? <span className="inp-pre">{pre}</span> : null}
      {props.as === 'textarea' ? (
        <textarea {...common} rows={props.rows ?? 3} spellCheck={props.spellCheck} maxLength={props.maxLength} />
      ) : (
        <input
          {...common}
          type={props.type ?? 'text'}
          autoComplete={props.autoComplete}
          spellCheck={props.spellCheck}
          inputMode={props.inputMode}
          maxLength={props.maxLength}
          autoCapitalize={props.autoCapitalize}
        />
      )}
      {end ? <span className="inp-end">{end}</span> : null}
    </div>
  );
}
