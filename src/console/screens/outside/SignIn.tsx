// Sign in (design: OutsideScreen, login variants): a plain text field for
// the one-time code and the button; the error reads "Invalid or expired
// code." Pending and error come from the store (session.login).

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { login } from '../../store/session/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Solo } from '../../ui/Solo/Solo.tsx';

export function SignIn() {
  const dispatch = useAppDispatch();
  const { pending, error } = useAppSelector(state => state.session.login);
  const [code, setCode] = useState('');
  const trimmed = code.trim();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (trimmed && !pending) {
      dispatch(login(trimmed));
    }
  };

  return (
    <Solo title="Sign in">
      <form className="form" onSubmit={onSubmit}>
        <Field label="One-time code" fid="code" err={error ? (error.status === 401 ? 'Invalid or expired code.' : error.message) : undefined}>
          <Input
            id="code"
            value={code}
            onChange={setCode}
            mono
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            invalid={error !== null}
            disabled={pending}
            ariaLabel="One-time code"
          />
        </Field>
        <Btn type="submit" label={pending ? 'Signing in' : 'Sign in'} variant="primary" block busy={pending} disabled={!trimmed} />
      </form>
    </Solo>
  );
}
