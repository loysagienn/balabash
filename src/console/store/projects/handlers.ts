// The effects of the registry's changes: one call per form at a time (a
// second press waits for the answer), the answer's row folded at once, a
// toast for the outcome. A created project opens its own page while the
// operator is still on the Projects screen the form belongs to; once they
// have gone elsewhere during the call, a late answer must not pull them
// back — the toast then carries "Open" instead. A form's failure stays in
// the store for the dialog to show; archiving has no form, so its failure
// is a toast.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { routeTo } from '../router/actions.ts';
import { pushToast } from '../ui/actions.ts';
import { createProjectDone, createProjectFail, setProjectArchivedDone, setProjectArchivedFail, updateProjectDone, updateProjectFail } from './actions.ts';

export const createProjectHandler: ActionHandler<'CREATE_PROJECT'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().projects.create.pending) {
      return;
    }

    next(action);

    try {
      const { project, adopted } = await api.projects.create(action.input);
      const route = { key: 'project', slug: project.slug } as const;
      const stillHere = getState().router.route.key === 'projects';

      dispatch(createProjectDone(action.input, project, adopted));
      dispatch(
        pushToast({
          title: 'Project created',
          desc: adopted ? `“${project.title}” — the existing folder ${project.slug}/ is its library; its files are kept.` : `“${project.title}” — folder ${project.slug}/ with AGENTS.md, inbox.md and journal.md.`,
          state: 'done',
          action: stillHere ? undefined : { label: 'Open', route },
        }),
      );

      if (stillHere) {
        dispatch(routeTo(route));
      }
    } catch (error) {
      dispatch(createProjectFail(action.input, toApiFailure(error)));
    }
  };

export const updateProjectHandler: ActionHandler<'UPDATE_PROJECT'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().projects.edit[action.id]?.pending) {
      return;
    }

    next(action);

    try {
      const { project } = await api.projects.update(action.id, action.patch);

      dispatch(updateProjectDone(action.id, project));
      dispatch(pushToast({ title: 'Saved', desc: `“${project.title}”`, state: 'done' }));
    } catch (error) {
      dispatch(updateProjectFail(action.id, toApiFailure(error)));
    }
  };

export const setProjectArchivedHandler: ActionHandler<'SET_PROJECT_ARCHIVED'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().projects.flagging[action.id]) {
      return;
    }

    next(action);

    try {
      const { project } = await (action.archived ? api.projects.archive(action.id) : api.projects.unarchive(action.id));

      dispatch(setProjectArchivedDone(action.id, project));
      dispatch(
        action.archived
          ? pushToast({ title: 'Archived', desc: `“${project.title}” — agents don’t pick it up; files and threads stay available.`, state: 'off' })
          : pushToast({ title: 'Unarchived', desc: `“${project.title}” is back among the active projects.`, state: 'done' }),
      );
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(setProjectArchivedFail(action.id, action.archived, failure));
      dispatch(pushToast({ title: action.archived ? 'Couldn’t archive' : 'Couldn’t unarchive', desc: failure.message, state: 'err' }));
    }
  };
