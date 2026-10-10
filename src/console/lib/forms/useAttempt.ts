// A dialog's attempt over a form's call state (attempt.ts), as a hook: the
// dialog begins an attempt at its submit, shows the refusal of that very
// attempt, dismisses it on new input, and is done when the store counted
// the call as accepted — the same rule for every dialog that changes a
// registry through the store, whatever its fields.

import { useEffect, useState } from 'react';
import { attemptAccepted, attemptAfterInput, attemptRefusal, openAttempt } from './attempt.ts';
import type { ApiFailure } from '../api/index.ts';
import type { FormAttempt, FormCallState } from './attempt.ts';

export type FormAttemptHook = {
  // The server's refusal of this dialog's attempt, or null.
  refusal: ApiFailure | null;
  busy: boolean;
  // The dialog submitted: the attempt opens at the store's count of now.
  begin: () => void;
  // The operator typed: a refusal is dismissed; a call in flight stands.
  input: () => void;
};

export function useFormAttempt(form: FormCallState, onDone: () => void): FormAttemptHook {
  const [attempt, setAttempt] = useState<FormAttempt | null>(() => openAttempt(form));

  useEffect(() => {
    if (attemptAccepted(attempt, form)) {
      onDone();
    }
  }, [form, attempt, onDone]);

  return {
    refusal: attemptRefusal(attempt, form),
    busy: form.pending,
    begin: () => setAttempt({ done: form.done }),
    input: () => setAttempt(current => attemptAfterInput(current, form)),
  };
}
