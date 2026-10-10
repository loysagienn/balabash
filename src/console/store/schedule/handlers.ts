// The effects of the schedule domain: the operator's manual run and delete
// of a task. One call per task at a time (schedule.calls[slug]), the
// outcome applied by the identity of that call — an answer that outlived
// its session (a sign-out, the next sign-in) touches nothing. A run's
// outcome is told by a toast in the task's own words — a command job's run
// started (its journal row is read by place), a note landed in the main
// thread, a code task runs on its own, a run still going burns this one —
// and so is a refusal (a sleeping code task, a missing task, a slug held
// by another row than the card showed). A delete
// drops the row and, when the operator is looking at that very task, leads
// back to the list: the detail of a deleted task has nothing to show.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { routeTo } from '../router/actions.ts';
import { pushToast } from '../ui/actions.ts';
import { deleteTaskDone, deleteTaskFail, runTaskDone, runTaskFail } from './actions.ts';
import { ownCall } from './reducer.ts';
import { selectTaskBySlug } from './selectors.ts';
import { deletedWords, runOutcomeWords } from './words.ts';

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
      dispatch(pushToast(runOutcomeWords(name, task?.kind ?? 'command', outcome)));
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
