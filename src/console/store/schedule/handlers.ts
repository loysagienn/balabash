// The effects of the schedule domain: the operator's new task, manual run
// and delete. A creation is a form (lib/forms/attempt.ts): the answer's row
// is folded at once (unless the tail told its end first — reducer.ts) and,
// while the operator is still on the form (the Schedule screen with `new`),
// the created task opens in its place (the list, when the row is gone); once
// they have gone elsewhere during the call, a late answer must not pull
// them back — the toast then carries "Open" instead; a refusal stays in
// the form state for the form to show. One call per task at a time (schedule.calls[slug]), the
// outcome applied by the identity of that call — an answer that outlived
// its session (a sign-out, the next sign-in) touches nothing. A run's
// outcome is told by a toast: program started, note delivered, run skipped
// or refusal from the registry. A delete
// drops the row and, when the operator is looking at that very task, leads
// back to the list: the detail of a deleted task has nothing to show.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { routeTo } from '../router/actions.ts';
import { pushToast } from '../ui/actions.ts';
import { createTaskDone, createTaskFail, deleteTaskDone, deleteTaskFail, runTaskDone, runTaskFail } from './actions.ts';
import { ownCall } from './reducer.ts';
import { selectTaskBySlug } from './selectors.ts';
import { createdWords, deletedWords, runOutcomeWords } from './words.ts';

export const createTaskHandler: ActionHandler<'CREATE_TASK'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().schedule.create.pending) {
      return;
    }

    next(action);

    const request = getState().schedule.create;

    try {
      const created = await api.schedule.createTask(action.input);

      if (getState().schedule.create !== request) {
        return;
      }

      const { route } = getState().router;
      const stillHere = route.key === 'schedule' && route.new === true;
      const target = { key: 'schedule', slug: created.task.slug } as const;

      dispatch(createTaskDone(request, created));

      // The row may be gone by now — the tail told its end (deleted
      // elsewhere, a past one-off consumed) before the answer came, or a
      // snapshot that lacks it replaced the list: the created task is then
      // not opened, and the form gives way to the list.
      const lives = Object.hasOwn(getState().schedule.tasks, created.task.id);

      dispatch(pushToast({ ...createdWords(created), action: stillHere || !lives ? undefined : { label: 'Open', route: target } }));

      if (stillHere) {
        dispatch(routeTo(lives ? target : { key: 'schedule', ...(route.key === 'schedule' && route.q ? { q: route.q } : {}) }, { replace: true }));
      }
    } catch (error) {
      if (getState().schedule.create !== request) {
        return;
      }

      dispatch(createTaskFail(request, toApiFailure(error)));
    }
  };

export const runTaskHandler: ActionHandler<'RUN_TASK'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (ownCall(getState().schedule.calls, action.slug)) {
      return;
    }

    next(action);

    const request = ownCall(getState().schedule.calls, action.slug);

    if (!request) {
      return;
    }

    const task = selectTaskBySlug(getState(), action.slug);
    const name = task?.name ?? action.slug;

    try {
      const outcome = await api.schedule.runTask(action.slug, action.id);

      if (ownCall(getState().schedule.calls, action.slug) !== request) {
        return;
      }

      dispatch(runTaskDone(action.slug, request, outcome));
      dispatch(pushToast(runOutcomeWords(name, outcome)));
    } catch (error) {
      if (ownCall(getState().schedule.calls, action.slug) !== request) {
        return;
      }

      const failure = toApiFailure(error);

      dispatch(runTaskFail(action.slug, request, failure));
      dispatch(pushToast({ title: `Couldn’t run “${name}”`, desc: failure.message, state: 'err' }));
    }
  };

export const deleteTaskHandler: ActionHandler<'DELETE_TASK'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (ownCall(getState().schedule.calls, action.slug)) {
      return;
    }

    next(action);

    const request = ownCall(getState().schedule.calls, action.slug);

    if (!request) {
      return;
    }

    const name = selectTaskBySlug(getState(), action.slug)?.name ?? action.slug;

    try {
      const deleted = await api.schedule.deleteTask(action.slug, action.id);

      if (ownCall(getState().schedule.calls, action.slug) !== request) {
        return;
      }

      dispatch(deleteTaskDone(action.slug, request, deleted));
      dispatch(pushToast(deletedWords(deleted.task.name)));

      const { route } = getState().router;

      if (route.key === 'schedule' && route.slug === action.slug) {
        dispatch(routeTo({ key: 'schedule' }, { replace: true }));
      }
    } catch (error) {
      if (ownCall(getState().schedule.calls, action.slug) !== request) {
        return;
      }

      const failure = toApiFailure(error);

      dispatch(deleteTaskFail(action.slug, request, failure));
      dispatch(pushToast({ title: `Couldn’t delete “${name}”`, desc: failure.message, state: 'err' }));
    }
  };
