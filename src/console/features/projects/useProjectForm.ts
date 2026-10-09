// The state of a project dialog: the values, the form's own errors (shown
// after the first submit, then kept current while typing), and the server's
// answer to this dialog's own attempt — the store keeps the last failure
// and the accepted count of the form; a submit opens an attempt at the
// count of that moment (projectForm.logic.ts: attempt*), the dialog shows
// the refusal of that attempt even when the operator typed on while the
// call ran, and closes when the count moved past it. The fields stay live
// during the call.

import { useEffect, useState } from 'react';
import type { ProjectFormState } from '../../store/projects/reducer.ts';
import { attemptAccepted, attemptAfterInput, attemptRefusal, fieldOfFailure, validateProjectForm } from './projectForm.logic.ts';
import type { FormAttempt, ProjectFormErrors, ProjectFormField, ProjectFormValues } from './projectForm.logic.ts';

export type ProjectFormHook = {
  values: ProjectFormValues;
  errors: ProjectFormErrors;
  failure: string | null;
  busy: boolean;
  change: (field: ProjectFormField, value: string) => void;
  // Checks the values; true when they pass (the dialog then dispatches).
  submit: () => boolean;
};

export function useProjectForm(initial: ProjectFormValues, mode: 'create' | 'edit', form: ProjectFormState, onDone: () => void, onChangeValues?: (field: ProjectFormField, value: string, values: ProjectFormValues) => ProjectFormValues): ProjectFormHook {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [attempt, setAttempt] = useState<FormAttempt | null>(null);

  // The store counted the call of this attempt as accepted: the dialog's
  // work is done.
  useEffect(() => {
    if (attemptAccepted(attempt, form)) {
      onDone();
    }
  }, [form, attempt, onDone]);

  const own = touched ? validateProjectForm(values, mode) : {};
  const errors: ProjectFormErrors = { ...own };
  let failure: string | null = null;
  const refusal = attemptRefusal(attempt, form);

  if (refusal) {
    const field = fieldOfFailure(refusal.message);

    if (field && !errors[field]) {
      errors[field] = refusal.message;
    } else if (!field) {
      failure = refusal.message;
    }
  }

  return {
    values,
    errors,
    failure,
    busy: form.pending,
    change: (field, value) => {
      setValues(current => (onChangeValues ? onChangeValues(field, value, current) : { ...current, [field]: value }));
      // A new value after a refusal dismisses it; during the call the
      // attempt stands — its answer is still to come.
      setAttempt(current => attemptAfterInput(current, form));
    },
    submit: () => {
      setTouched(true);

      if (form.pending || Object.keys(validateProjectForm(values, mode)).length > 0) {
        return false;
      }

      setAttempt({ done: form.done });

      return true;
    },
  };
}
