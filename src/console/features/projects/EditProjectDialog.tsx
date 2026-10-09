// "Edit project" (design: ProjectScreen modal): the name and the
// description over UPDATE_PROJECT; the folder is shown fixed. The patch is
// what the operator changed against the values the dialog opened with
// (projectPatch), so a field they left alone never goes back — the row
// may have moved from the tail meanwhile. Nothing changed — the dialog
// just closes, no call.

import { useCallback, useState } from 'react';
import type { ProjectView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { updateProject } from '../../store/projects/actions.ts';
import { selectProjectEdit } from '../../store/projects/selectors.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { ProjectForm } from './ProjectForm.tsx';
import { projectPatch } from './projectForm.logic.ts';
import { useProjectForm } from './useProjectForm.ts';

const FORM_ID = 'edit-project';

export function EditProjectDialog({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const form = useAppSelector(s => selectProjectEdit(s, project.id));
  const done = useCallback(() => onClose(), [onClose]);
  // The values at opening — the base the patch is measured against.
  const [base] = useState(() => ({ title: project.title, slug: project.slug, description: project.description }));
  const { values, errors, failure, busy, change, submit } = useProjectForm(base, 'edit', form, done);

  return (
    <Dialog title="Edit project" confirm="Save" form={FORM_ID} busy={busy} onClose={onClose}>
      <ProjectForm
        id={FORM_ID}
        mode="edit"
        values={values}
        errors={errors}
        failure={failure}
        onChange={change}
        onSubmit={() => {
          if (!submit()) {
            return;
          }

          const patch = projectPatch(base, values);

          if (patch) {
            dispatch(updateProject(project.id, patch));
          } else {
            onClose();
          }
        }}
      />
    </Dialog>
  );
}
