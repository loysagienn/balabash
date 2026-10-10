// Sign in (design: OutsideScreen, login variants): a plain text field for
// the one-time code and the button; the error reads "Invalid or expired
// code." Pending and error come from the store (session.login). The word
// "console" instead of a code asks the server to print one into its own
// log (the way in without any channel); the field's hint then says where
// the code went. The route stays whatever it was: after sign-in the screen
// the link led to appears (App), the /login door leads to its `next`.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { login, requestConsoleCode } from '../../store/session/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Solo } from '../../ui/Solo/Solo.tsx';
import { CODE_PRINTED_HINT, errorWords, isConsoleWord, submitLabel } from './SignIn.logic.ts';

export function SignIn() {
  const dispatch = useAppDispatch();
  const { pending, error, codePrinted } = useAppSelector(state => state.session.login);
  const [code, setCode] = useState('');
  const trimmed = code.trim();
  const busy = pending !== null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!trimmed || busy) {
      return;
    }

    if (isConsoleWord(trimmed)) {
      // The word is not a code: the field is for the code that follows.
      setCode('');
      dispatch(requestConsoleCode());
    } else {
      dispatch(login(trimmed));
    }
  };

  return (
    <Solo title="Sign in">
      <form className="form" onSubmit={onSubmit}>
        <Field label="One-time code" fid="code" required hint={codePrinted ? CODE_PRINTED_HINT : undefined} err={error ? errorWords(error) : undefined}>
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
            disabled={busy}
            ariaLabel="One-time code"
          />
        </Field>
        <Btn type="submit" label={submitLabel(pending)} variant="primary" block busy={busy} disabled={!trimmed} />
      </form>
    </Solo>
  );
}
