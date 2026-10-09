// The project form (design: ProjectForm): name, folder (derived from the
// name until the operator edits it; fixed once the project exists —
// threads and files link to it) and description. The same fields in the
// "New project" and "Edit project" dialogs; the dialog owns the values and
// the submit, the form draws them with the errors under the fields — the
// form's own checks or the server's refusal — and one line above for a
// refusal that names no single field. A submit that fails the form's own
// checks moves the focus to the first field at fault (focusFirstInvalid,
// after the errors are drawn); a refusal of the server is announced by
// the error line itself. All three fields are required — the server's rule
// (a description is how agents match conversations to the project), so no
// "optional" mark, whatever the design's sketch says.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Field, focusFirstInvalid } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { DESCRIPTION_MAX_LENGTH, SLUG_MAX_LENGTH, TITLE_MAX_LENGTH } from './projectForm.logic.ts';
import type { ProjectFormErrors, ProjectFormField, ProjectFormValues } from './projectForm.logic.ts';

export type ProjectFormProps = {
  id: string;
  mode: 'create' | 'edit';
  values: ProjectFormValues;
  errors: ProjectFormErrors;
  // A refusal of the server that belongs to no single field.
  failure?: string | null;
  onChange: (field: ProjectFormField, value: string) => void;
  onSubmit: () => void;
};

export function ProjectForm({ id, mode, values, errors, failure, onChange, onSubmit }: ProjectFormProps) {
  const form = useRef<HTMLFormElement>(null);
  const [attempts, setAttempts] = useState(0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
    setAttempts(n => n + 1);
  };
  const fid = (field: ProjectFormField) => `${id}-${field}`;

  // After a submit the errors of that attempt are on the screen: the
  // focus goes to the first of them (none — the call went out, the focus
  // stays).
  useEffect(() => {
    if (attempts > 0) {
      focusFirstInvalid(form.current);
    }
  }, [attempts]);

  return (
    <form id={id} className="form" ref={form} onSubmit={submit} noValidate>
      {failure ? (
        <Note state="err" icon="circle-alert" role="alert">
          {failure}
        </Note>
      ) : null}
      <Field label="Name" fid={fid('title')} err={errors.title} required>
        <Input id={fid('title')} name="title" value={values.title} onChange={value => onChange('title', value)} maxLength={TITLE_MAX_LENGTH} autoComplete="off" autoFocus invalid={Boolean(errors.title)} />
      </Field>
      {mode === 'create' ? (
        <Field label="Folder" fid={fid('slug')} hint="A folder in the file area; AGENTS.md will appear in it. Can’t be changed after creation." err={errors.slug} required>
          <Input id={fid('slug')} name="slug" value={values.slug} onChange={value => onChange('slug', value)} pre="~/" mono maxLength={SLUG_MAX_LENGTH} autoComplete="off" autoCapitalize="off" spellCheck={false} invalid={Boolean(errors.slug)} />
        </Field>
      ) : null}
      <Field label="Description" fid={fid('description')} err={errors.description} required>
        <Input
          as="textarea"
          id={fid('description')}
          name="description"
          value={values.description}
          onChange={value => onChange('description', value)}
          rows={3}
          maxLength={DESCRIPTION_MAX_LENGTH}
          placeholder="What the project is about — agents read this first"
          invalid={Boolean(errors.description)}
        />
      </Field>
      {mode === 'edit' ? (
        <Field label="Folder" fid={fid('slug')} hint="The folder can’t be renamed: threads and files link to it.">
          <Input id={fid('slug')} name="slug" value={`${values.slug}/`} onChange={() => undefined} mono disabled />
        </Field>
      ) : null}
    </form>
  );
}
