// The state of a project dialog: the values, the form's own errors (shown
// after the first submit, then kept current while typing), and the server's
// refusal of this dialog's own call — the store keeps the last failure of
// the form, the dialog shows it only once it has submitted, and closes when
// the store counts one more accepted call.

import { useEffect, useRef, useState } from 'react';
import type { ProjectFormState } from '../../store/projects/reducer.ts';
import { fieldOfFailure, validateProjectForm } from './projectForm.logic.ts';
import type { ProjectFormErrors, ProjectFormField, ProjectFormValues } from './projectForm.logic.ts';

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
  const [submitted, setSubmitted] = useState(false);
  const doneAtOpen = useRef(form.done);

  // The store counted one more accepted call of this form after the dialog
  // submitted: the dialog's work is done.
  useEffect(() => {
    if (submitted && form.done !== doneAtOpen.current) {
      onDone();
    }
  }, [form.done, submitted, onDone]);

  const own = touched ? validateProjectForm(values, mode) : {};
  const errors: ProjectFormErrors = { ...own };
  let failure: string | null = null;

  if (submitted && form.error && !form.pending) {
    const field = fieldOfFailure(form.error.message);

    if (field && !errors[field]) {
      errors[field] = form.error.message;
    } else if (!field) {
      failure = form.error.message;
    }
  }

  return {
    values,
    errors,
    failure,
    busy: form.pending,
    change: (field, value) => {
      setValues(current => (onChangeValues ? onChangeValues(field, value, current) : { ...current, [field]: value }));
      // A new value is a new attempt: the old refusal no longer applies.
      setSubmitted(false);
    },
    submit: () => {
      setTouched(true);

      if (form.pending || Object.keys(validateProjectForm(values, mode)).length > 0) {
        return false;
      }

      setSubmitted(true);

      return true;
    },
  };
}
