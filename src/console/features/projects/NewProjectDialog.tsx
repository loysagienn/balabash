// "New project" (design: ProjectsScreen modal / sheet): the form over
// CREATE_PROJECT. The folder follows the name until the operator types a
// folder of their own; a created project opens its page (the handler
// routes there), so the dialog just closes.

import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { createProject } from '../../store/projects/actions.ts';
import { selectProjectCreate } from '../../store/projects/selectors.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { ProjectForm } from './ProjectForm.tsx';
import { slugFromTitle } from './projectForm.logic.ts';
import type { ProjectFormValues } from './projectForm.logic.ts';
import { useProjectForm } from './useProjectForm.ts';

const FORM_ID = 'new-project';

export function NewProjectDialog({ initialTitle = '', onClose }: { initialTitle?: string; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const form = useAppSelector(selectProjectCreate);
  const done = useCallback(() => onClose(), [onClose]);
  const { values, errors, failure, busy, change, submit } = useProjectForm({ title: initialTitle, slug: slugFromTitle(initialTitle), description: '' }, 'create', form, done, (field, value, current) => {
    if (field === 'title' && current.slug === slugFromTitle(current.title)) {
      // The folder still follows the name.
      return { ...current, title: value, slug: slugFromTitle(value) };
    }

    return { ...current, [field]: value };
  });

  return (
    <Dialog title="New project" confirm="Create project" confirmIcon="plus" form={FORM_ID} busy={busy} onClose={onClose}>
      <ProjectForm
        id={FORM_ID}
        mode="create"
        values={values}
        errors={errors}
        failure={failure}
        onChange={change}
        onSubmit={() => {
          if (submit()) {
            dispatch(createProject(trimmed(values)));
          }
        }}
      />
    </Dialog>
  );
}

function trimmed(values: ProjectFormValues): ProjectFormValues {
  return { title: values.title.trim(), slug: values.slug.trim(), description: values.description.trim() };
}
